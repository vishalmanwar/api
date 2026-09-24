const EXT_VERSION='2026.09.24.10-opera';
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
      const location=(line1+' '+line2).replace(/\s+/g,' ').trim();
      const cards=[...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')]
        .map((el,index)=>{
          const asin=(el.getAttribute('data-asin')||'').trim().toUpperCase();
          const text=(el.textContent||'').replace(/\s+/g,' ').trim();
          const sponsored=/\bSponsored\b/i.test(text) ||
            !!el.querySelector('[aria-label*="Sponsored"],[data-component-type="sp-sponsored-result"],[class*="s-sponsored"]');
          return {asin,sponsored,absolute:index+1};
        }).filter(x=>x.asin);
      return {title:document.title,url:location.href,bodyChars:body.length,location,cards};
    }
  });
  return res?.result||{};
}

async function setPincode(tabId,pincode){
  const snap=await amazonSnapshot(tabId);
  if((snap.bodyChars||0)<100) throw new Error('Amazon page did not load normally.');
  const loc=String(snap.location||'');
  if(!loc.includes(String(pincode))){
    throw new Error('Open Amazon.in in this Edge window, manually set delivery pincode to '+pincode+', confirm the header shows '+pincode+', then click Run now again. Current header: '+loc);
  }
  return loc;
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

    if(!chosen) throw new Error('No Amazon.in tab found. Open Amazon.in, set pincode 380015 manually, then click Run now once.');
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
    if(err.startsWith('MANUAL_PINCODE_REQUIRED|')){
      const parts=err.split('|');
      const wanted=parts[1]||'380015';
      const current=parts.slice(2).join('|')||'unknown';
      await setStatus('Action needed v'+EXT_VERSION+': Amazon is overriding the delivery pincode. In the Amazon tab, click Update location, enter '+wanted+', click Apply, and confirm the header shows '+wanted+'. Then click Run now again. Current header: '+current,{lastError:err,extensionVersion:EXT_VERSION,needsManualPincode:true});
      // Keep the Amazon tab open and make it visible so the user can correct location once.
      if(tab?.id){
        await chrome.tabs.update(tab.id,{active:true}).catch(()=>{});
        tab=null;
      }
    }else{
      await setStatus('Failed v'+EXT_VERSION+': '+err,{lastError:err,extensionVersion:EXT_VERSION});
    }
    const setupPincodeIssue=/manually set delivery pincode|Current header:|No Amazon\.in tab found/i.test(err);
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
  if(!alarm) await chrome.alarms.create('rank-poll',{periodInMinutes:5});
}

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
