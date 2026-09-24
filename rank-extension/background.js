const EXT_VERSION='2026.09.24.13-opera-auto-poll';
const API='https://ywrtgkdkntjyeqdnrbop.supabase.co/functions/v1/rank-intelligence';
let running=false;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getToken(){
  const {token=''}=await chrome.storage.local.get('token');
  return token.trim();
}

async function setStatus(status,extra={}){
  await chrome.storage.local.set({status,updatedAt:new Date().toISOString(),...extra});
}

async function api(action,{method='GET',body=null,force=false}={}){
  const token=await getToken();
  if(!token) throw new Error('Agent token is missing.');
  const url=API+'?action='+encodeURIComponent(action)+(force?'&force=1':'');
  const r=await fetch(url,{
    method,
    headers:{'Content-Type':'application/json','X-Rank-Agent':token},
    body:body?JSON.stringify(body):undefined
  });
  const text=await r.text();
  let data={}; try{data=JSON.parse(text)}catch{}
  if(!r.ok) throw new Error(data.error||('HTTP '+r.status+' '+text));
  return data;
}

async function waitTabComplete(tabId,timeout=60000){
  const current=await chrome.tabs.get(tabId).catch(()=>null);
  if(current?.status==='complete') return current;
  return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('Amazon tab timed out.'));
    },timeout);
    function onUpdated(id,info,tab){
      if(id===tabId && info.status==='complete'){
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(tab);
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function navigate(tabId,url){
  await chrome.tabs.update(tabId,{url});
  await waitTabComplete(tabId,60000);
  await sleep(1800);
}

async function amazonSnapshot(tabId){
  const [res]=await chrome.scripting.executeScript({
    target:{tabId},
    func:()=>{
      const body=(document.body?.innerText||'').trim();
      const line1=(document.querySelector('#glow-ingress-line1')?.textContent||'').trim();
      const line2=(document.querySelector('#glow-ingress-line2')?.textContent||'').trim();
      const locationText=(line1+' '+line2).replace(/\s+/g,' ').trim();
      const cards=[...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')]
        .map((el,index)=>{
          const asin=(el.getAttribute('data-asin')||'').trim().toUpperCase();
          const text=(el.textContent||'').replace(/\s+/g,' ').trim();
          const sponsored=/\bSponsored\b/i.test(text) ||
            !!el.querySelector('[aria-label*="Sponsored"],[data-component-type="sp-sponsored-result"],[class*="s-sponsored"]');
          return {asin,sponsored,absolute:index+1};
        }).filter(x=>x.asin);
      return {title:document.title,url:window.location.href,bodyChars:body.length,location:locationText,cards};
    }
  });
  return res?.result||{};
}


async function cdp(tabId,method,params={}){
  return await chrome.debugger.sendCommand({tabId},method,params);
}

async function realClick(tabId,x,y){
  await cdp(tabId,'Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'none'});
  await cdp(tabId,'Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
  await cdp(tabId,'Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
}

async function setPincode(tabId,pincode){
  // Always begin from Amazon home so the location control is present.
  await navigate(tabId,'https://www.amazon.in/');
  let snap=await amazonSnapshot(tabId);
  if((snap.bodyChars||0)<100) throw new Error('Amazon homepage did not load normally.');

  if(String(snap.location||'').includes(String(pincode))) return snap.location;

  await chrome.debugger.attach({tabId},'1.3').catch(e=>{
    if(!String(e?.message||e).includes('Another debugger is already attached')) throw e;
  });

  try{
    // Open Amazon's delivery-location popup using a browser-level click.
    const [loc]=await chrome.scripting.executeScript({
      target:{tabId},
      func:()=>{
        const el=document.querySelector('#nav-global-location-popover-link') ||
                 document.querySelector('#glow-ingress-block');
        if(!el) return null;
        const r=el.getBoundingClientRect();
        return {x:r.left+r.width/2,y:r.top+r.height/2};
      }
    });
    if(!loc?.result) throw new Error('Amazon Update location control not found.');
    await realClick(tabId,loc.result.x,loc.result.y);

    // Amazon loads the location popover asynchronously. Wait up to ~10 seconds
    // and retry the location click once if necessary.
    let ui=null;
    for(let attempt=0;attempt<20;attempt++){
      await sleep(500);
      const [probe]=await chrome.scripting.executeScript({
        target:{tabId},
        func:()=>{
          const visible=el=>{
            if(!el) return false;
            const r=el.getBoundingClientRect();
            return r.width>0 && r.height>0;
          };
          const candidates=[
            document.querySelector('#GLUXZipUpdateInput'),
            document.querySelector('input[data-action="GLUXPostalInputAction"]'),
            document.querySelector('input[placeholder*="pincode" i]'),
            document.querySelector('input[placeholder*="postal" i]'),
            document.querySelector('input[aria-label*="pincode" i]'),
            document.querySelector('input[aria-label*="postal" i]'),
            ...document.querySelectorAll('.a-popover input[type="text"], .a-popover input:not([type]), [role="dialog"] input[type="text"]')
          ].find(visible);

          const applyCandidates=[
            document.querySelector('#GLUXZipUpdate'),
            document.querySelector('input[aria-labelledby="GLUXZipUpdate-announce"]'),
            document.querySelector('input.a-button-input[type="submit"]'),
            ...document.querySelectorAll('.a-popover button,.a-popover input[type="submit"],[role="dialog"] button,[role="dialog"] input[type="submit"]')
          ];
          const apply=applyCandidates.find(el=>visible(el) && /apply|update|use this|done|continue/i.test((el.value||el.textContent||el.getAttribute('aria-label')||'').trim())) ||
                      applyCandidates.find(visible);

          if(!candidates || !apply) return null;
          const ir=candidates.getBoundingClientRect();
          const ar=apply.getBoundingClientRect();
          return {
            input:{x:ir.left+ir.width/2,y:ir.top+ir.height/2},
            apply:{x:ar.left+ar.width/2,y:ar.top+ar.height/2}
          };
        }
      });
      if(probe?.result){ ui=probe.result; break; }

      // If the first click did not open the popover, click Update location again once.
      if(attempt===5){
        await realClick(tabId,loc.result.x,loc.result.y);
      }
    }

    if(!ui) throw new Error('Amazon location popup did not expose the pincode input after waiting.');

    await realClick(tabId,ui.input.x,ui.input.y);

    // Ctrl+A and type the target pincode using trusted browser input events.
    await cdp(tabId,'Input.dispatchKeyEvent',{type:'keyDown',modifiers:2,key:'a',code:'KeyA',windowsVirtualKeyCode:65});
    await cdp(tabId,'Input.dispatchKeyEvent',{type:'keyUp',modifiers:2,key:'a',code:'KeyA',windowsVirtualKeyCode:65});
    await cdp(tabId,'Input.insertText',{text:String(pincode)});
    await sleep(300);

    await realClick(tabId,ui.apply.x,ui.apply.y);
    await sleep(1800);

    // Some Amazon sessions show an extra Done/Continue button.
    const [confirm]=await chrome.scripting.executeScript({
      target:{tabId},
      func:()=>{
        const el=document.querySelector('#GLUXConfirmClose') ||
                 document.querySelector('button[name="glowDoneButton"]') ||
                 document.querySelector('input[name="glowDoneButton"]') ||
                 [...document.querySelectorAll('button,input')].find(x=>/done|continue/i.test((x.value||x.textContent||'').trim()));
        if(!el) return null;
        const r=el.getBoundingClientRect();
        return {x:r.left+r.width/2,y:r.top+r.height/2};
      }
    });
    if(confirm?.result){
      await realClick(tabId,confirm.result.x,confirm.result.y);
      await sleep(800);
    }

    await chrome.tabs.reload(tabId);
    await waitTabComplete(tabId,60000);
    await sleep(1200);

    snap=await amazonSnapshot(tabId);
    if(!String(snap.location||'').includes(String(pincode))){
      throw new Error('AUTO_PIN_FAILED|Wanted '+pincode+'|Header '+(snap.location||'unknown'));
    }
    return snap.location;
  }finally{
    await chrome.debugger.detach({tabId}).catch(()=>{});
  }
}

async function scrapeKeyword(tabId,keyword,rules,pincode){
  let organicCounter=0,sponsoredCounter=0,absoluteCounter=0,sponsoredSeen=0;
  const found=new Map();

  for(let pageNum=1;pageNum<=3;pageNum++){
    const url='https://www.amazon.in/s?k='+encodeURIComponent(keyword)+(pageNum>1?'&page='+pageNum:'');
    await navigate(tabId,url);
    const snap=await amazonSnapshot(tabId);

    if((snap.bodyChars||0)<100 || !Array.isArray(snap.cards) || !snap.cards.length){
      throw new Error('Amazon search did not return product cards. Title: '+(snap.title||'')+' URL: '+(snap.url||''));
    }
    if(!String(snap.location||'').includes(String(pincode))){
      throw new Error('Amazon search page lost pincode '+pincode+'. Header: '+(snap.location||''));
    }

    for(const card of snap.cards){
      absoluteCounter++;
      if(card.sponsored){sponsoredCounter++;sponsoredSeen++;}
      else organicCounter++;

      const target=rules.find(r=>String(r.asin).toUpperCase()===card.asin);
      if(!target) continue;
      const cur=found.get(card.asin)||{
        organic_rank:null,organic_page:null,organic_absolute_position:null,
        sponsored_found:false,sponsored_position:null,sponsored_page:null,
        sponsored_absolute_position:null,total_sponsored_ads_before_organic:null
      };

      if(card.sponsored && !cur.sponsored_found){
        cur.sponsored_found=true;
        cur.sponsored_position=sponsoredCounter;
        cur.sponsored_page=pageNum;
        cur.sponsored_absolute_position=absoluteCounter;
      } else if(!card.sponsored && cur.organic_rank===null){
        cur.organic_rank=organicCounter;
        cur.organic_page=pageNum;
        cur.organic_absolute_position=absoluteCounter;
        cur.total_sponsored_ads_before_organic=sponsoredSeen;
      }
      found.set(card.asin,cur);
    }

    if(rules.every(r=>found.get(String(r.asin).toUpperCase())?.organic_rank!=null)) break;
    await sleep(900);
  }

  return rules.map(rule=>{
    const f=found.get(String(rule.asin).toUpperCase())||{};
    return {
      rule_id:rule.rule_id,
      asin:rule.asin,
      keyword:rule.keyword,
      pincode,
      device:rule.device,
      checked_at:new Date().toISOString(),
      status:'SUCCESS',
      organic_rank:f.organic_rank??null,
      organic_page:f.organic_page??null,
      organic_absolute_position:f.organic_absolute_position??null,
      sponsored_found:!!f.sponsored_found,
      sponsored_position:f.sponsored_position??null,
      sponsored_page:f.sponsored_page??null,
      sponsored_absolute_position:f.sponsored_absolute_position??null,
      total_sponsored_ads_before_organic:f.total_sponsored_ads_before_organic??null,
      total_results_scanned:absoluteCounter
    };
  });
}

async function runCheck(force=false){
  if(running) return {ok:false,message:'Already running'};
  running=true;
  let tab=null;
  let conf=null;
  try{
    await setStatus('Starting rank check… v'+EXT_VERSION,{lastError:null,extensionVersion:EXT_VERSION});
    conf=await api('local_worker_config',{force});
    if(conf.mode==='skip'){
      await setStatus('No rank check due.');
      return {ok:true,skipped:true};
    }

    // Reuse the exact Amazon tab that previously produced a successful 380015 run.
    const storedTab=await chrome.storage.local.get(['preferredAmazonTabId']);
    let chosen=null;

    if(storedTab.preferredAmazonTabId){
      const remembered=await chrome.tabs.get(Number(storedTab.preferredAmazonTabId)).catch(()=>null);
      if(remembered && /^https:\/\/www\.amazon\.in\//i.test(remembered.url||'')){
        chosen=remembered;
      }
    }

    // On a manual Run now, prefer the active Amazon tab so the user can explicitly
    // establish which Amazon session/tab should be used for future queued checks.
    if(force){
      const activeTabs=await chrome.tabs.query({active:true,currentWindow:true});
      const activeAmazon=activeTabs.find(t=>/^https:\/\/www\.amazon\.in\//i.test(t.url||''));
      if(activeAmazon) chosen=activeAmazon;
    }

    // If no remembered tab exists, scan all Amazon tabs across Edge windows and
    // prefer one that already shows the required pincode.
    if(!chosen){
      const amazonTabs=await chrome.tabs.query({url:['https://www.amazon.in/*']});
      const wanted=String(conf.default_pincode||'380015');
      for(const candidate of amazonTabs){
        try{
          const s=await amazonSnapshot(candidate.id);
          if(String(s.location||'').includes(wanted)){chosen=candidate;break;}
        }catch{}
      }
      if(!chosen) chosen=amazonTabs[0]||null;
    }

    if(!chosen){
      chosen=await chrome.tabs.create({url:'https://www.amazon.in/',active:true});
      await waitTabComplete(chosen.id,60000);
    }
    tab=chosen;
    await chrome.tabs.update(tab.id,{active:true});
    await waitTabComplete(tab.id,60000).catch(()=>{});

    const results=[];
    const groups=new Map();
    for(const rule of conf.rules||[]){
      const key=String(rule.pincode)+'|'+String(rule.device||'desktop');
      if(!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(rule);
    }

    for(const [key,rules] of groups){
      const [pincode]=key.split('|');
      await setStatus('Setting Amazon pincode '+pincode+'…');
      const location=await setPincode(tab.id,pincode);
      await chrome.storage.local.set({preferredAmazonTabId:tab.id,preferredAmazonWindowId:tab.windowId,preferredPincode:pincode});
      await setStatus('Verified '+location+'. Checking keywords…');

      const byKeyword=new Map();
      for(const r of rules){
        if(!byKeyword.has(r.keyword)) byKeyword.set(r.keyword,[]);
        byKeyword.get(r.keyword).push(r);
      }

      for(const [keyword,rr] of byKeyword){
        try{
          await setStatus('Checking: '+keyword);
          results.push(...await scrapeKeyword(tab.id,keyword,rr,pincode));
        }catch(e){
          results.push(...rr.map(r=>({
            rule_id:r.rule_id,asin:r.asin,keyword:r.keyword,pincode,device:r.device,
            checked_at:new Date().toISOString(),status:'FAILED',error:e?.message||String(e)
          })));
        }
        await sleep(700);
      }
    }

    const runId='chrome-extension-'+Date.now();
    const stored=await api('local_worker_ingest',{
      method:'POST',
      body:{
        run_id:runId,
        mode:conf.mode,
        request_id:conf.request_id||null,
        results
      }
    });

    await setStatus('Completed: '+stored.success+' success, '+stored.failed+' failed.',{
      lastRunAt:new Date().toISOString(),
      lastSuccess:stored.success,
      lastFailed:stored.failed
    });
    return {ok:true,...stored};
  }catch(e){
    const err=e?.message||String(e);
    if(err.startsWith('AUTO_PIN_FAILED|')){
      const parts=err.split('|');
      const wanted=(parts[1]||'Wanted 380015').replace('Wanted ','');
      const current=parts.slice(2).join('|')||'unknown';
      await setStatus('Automatic pincode setup failed v'+EXT_VERSION+'. Wanted '+wanted+'. '+current,{lastError:err,extensionVersion:EXT_VERSION,needsManualPincode:false});
      // Keep the Amazon tab open and make it visible so the user can correct location once.
      if(tab?.id){
        await chrome.tabs.update(tab.id,{active:true}).catch(()=>{});
        tab=null;
      }
    }else{
      await setStatus('Failed v'+EXT_VERSION+': '+err,{lastError:err,extensionVersion:EXT_VERSION});
    }
    const setupPincodeIssue=/AUTO_PIN_FAILED|Amazon location popup|Update location control not found|Pincode input not found|Apply button not found/i.test(err);
    if(conf?.rules?.length && !setupPincodeIssue){
      const failedResults=conf.rules.map(r=>({
        rule_id:r.rule_id,
        asin:r.asin,
        keyword:r.keyword,
        pincode:r.pincode,
        device:r.device,
        checked_at:new Date().toISOString(),
        status:'FAILED',
        error:'SETUP '+err
      }));
      try{
        await api('local_worker_ingest',{
          method:'POST',
          body:{
            run_id:'edge-extension-debug-'+Date.now(),
            mode:conf.mode,
            request_id:conf.request_id||null,
            provider:'browser-extension',
            provider_name:'Zipify Edge Rank Extension',
            results:failedResults
          }
        });
      }catch{}
    }
    if(setupPincodeIssue){
      if(conf?.request_id){
        try{
          await api('local_worker_release',{
            method:'POST',
            body:{request_id:conf.request_id,reason:err}
          });
        }catch{}
      }
      return {ok:false,needsPincode:true,message:err};
    }
    throw e;
  }finally{
    running=false;
    // Keep the user's Amazon tab open.
  }
}

async function ensureAlarm(){
  const alarm=await chrome.alarms.get('rank-poll');
  if(!alarm || Number(alarm.periodInMinutes)!==1){
    if(alarm) await chrome.alarms.clear('rank-poll');
    await chrome.alarms.create('rank-poll',{delayInMinutes:0.1,periodInMinutes:1});
  }
}

// Recreate the polling alarm whenever the service worker loads, not only on
// install/browser startup. This is important for Opera unpacked-extension reloads.
ensureAlarm().catch(()=>{});
chrome.runtime.onInstalled.addListener(()=>{ensureAlarm();});
chrome.runtime.onStartup.addListener(()=>{ensureAlarm();});
chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name==='rank-poll') runCheck(false).catch(()=>{});
});

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg?.type==='runNow'){
    runCheck(true).catch(()=>{});
    sendResponse({ok:true,started:true});
    return;
  }
  if(msg?.type==='ensureAlarm'){
    ensureAlarm().then(()=>sendResponse({ok:true}));
    return true;
  }
});
