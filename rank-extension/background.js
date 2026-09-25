const EXT_VERSION='2026.09.25.40-multi-market';
const API='https://ywrtgkdkntjyeqdnrbop.supabase.co/functions/v1/rank-intelligence';
const ALARM='rank-poll';
const POLL_MINUTES=1;
const SETUP_RETRY_MS=120000;
let running=false;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getToken(){
  const {token=''}=await chrome.storage.local.get('token');
  return String(token||'').trim();
}

async function setStatus(status,extra={}){
  await chrome.storage.local.set({status,updatedAt:new Date().toISOString(),extensionVersion:EXT_VERSION,...extra});
}

async function api(action,{method='GET',body=null,force=false}={}){
  const token=await getToken();
  if(!token) throw new Error('Agent token is missing.');
  const url=API+'?action='+encodeURIComponent(action)+(force?'&force=1':'');
  const r=await fetch(url,{
    method,
    headers:{
      'Content-Type':'application/json',
      'X-Rank-Agent':token,
      'X-Rank-Agent-Version':EXT_VERSION
    },
    body:body==null?undefined:JSON.stringify(body)
  });
  const raw=await r.text();
  let data={};
  try{data=JSON.parse(raw)}catch{}
  if(!r.ok) throw new Error(data.error||('HTTP '+r.status+' '+raw));
  return data;
}

async function waitTabComplete(tabId,timeout=60000){
  const cur=await chrome.tabs.get(tabId).catch(()=>null);
  if(cur?.status==='complete') return cur;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      chrome.tabs.onUpdated.removeListener(done);
      reject(new Error('Amazon tab timed out.'));
    },timeout);
    function done(id,info,tab){
      if(id===tabId&&info.status==='complete'){
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(done);
        resolve(tab);
      }
    }
    chrome.tabs.onUpdated.addListener(done);
  });
}

async function navigate(tabId,url){
  await chrome.tabs.update(tabId,{url,active:true});
  await waitTabComplete(tabId,60000);
  await sleep(1200);
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

async function cdp(tabId,method,params={}){
  return chrome.debugger.sendCommand({tabId},method,params);
}

async function attachDebugger(tabId){
  try{await chrome.debugger.attach({tabId},'1.3')}
  catch(e){
    const msg=String(e?.message||e);
    if(!msg.includes('Another debugger is already attached')) throw e;
  }
}

async function realClick(tabId,x,y){
  await cdp(tabId,'Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'none'});
  await cdp(tabId,'Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
  await cdp(tabId,'Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
}

async function findLocationButton(tabId){
  const [r]=await chrome.scripting.executeScript({
    target:{tabId},
    func:()=>{
      const visible=el=>{
        if(!el)return false;
        const r=el.getBoundingClientRect();
        return r.width>0&&r.height>0;
      };
      const el=[
        document.querySelector('#nav-global-location-popover-link'),
        document.querySelector('#glow-ingress-block'),
        document.querySelector('[data-csa-c-content-id="nav-global-location-popover-link"]')
      ].find(visible);
      if(!el)return null;
      const b=el.getBoundingClientRect();
      return {x:b.left+b.width/2,y:b.top+b.height/2};
    }
  });
  return r?.result||null;
}

async function findLocationControls(tabId){
  const [r]=await chrome.scripting.executeScript({
    target:{tabId},
    func:()=>{
      const visible=el=>{
        if(!el)return false;
        const r=el.getBoundingClientRect(),s=getComputedStyle(el);
        return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';
      };
      const input=[
        document.querySelector('#GLUXZipUpdateInput'),
        document.querySelector('input[data-action="GLUXPostalInputAction"]'),
        document.querySelector('input[placeholder*="pincode" i]'),
        document.querySelector('input[placeholder*="postal" i]'),
        document.querySelector('input[placeholder*="zip" i]'),
        document.querySelector('input[aria-label*="pincode" i]'),
        document.querySelector('input[aria-label*="postal" i]'),
        document.querySelector('input[aria-label*="zip" i]'),
        ...document.querySelectorAll('.a-popover input[type="text"],.a-popover input:not([type]),[role="dialog"] input[type="text"]')
      ].find(visible);

      const all=[...document.querySelectorAll(
        '#GLUXZipUpdate,input[aria-labelledby="GLUXZipUpdate-announce"],.a-popover button,.a-popover input[type="submit"],[role="dialog"] button,[role="dialog"] input[type="submit"]'
      )].filter(visible);
      const apply=all.find(el=>/apply|update|use this|continue/i.test(
        (el.value||el.textContent||el.getAttribute('aria-label')||'').trim()
      ))||all[0];
      if(!input||!apply)return null;
      const ir=input.getBoundingClientRect(),ar=apply.getBoundingClientRect();
      return {
        input:{x:ir.left+ir.width/2,y:ir.top+ir.height/2},
        apply:{x:ar.left+ar.width/2,y:ar.top+ar.height/2}
      };
    }
  });
  return r?.result||null;
}

function domainOrigin(domain){
  const d=String(domain||'www.amazon.in').replace(/^https?:\/\//i,'').replace(/\/.*$/,'');
  return 'https://'+d;
}

function validLocation(locationType,value){
  const v=String(value||'').trim();
  if(locationType==='postal_code')return /^\d{5}(?:-\d{4})?$/.test(v);
  return /^\d{6}$/.test(v);
}

async function verifyLocation(tabId,value,timeout=12000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    const snap=await amazonSnapshot(tabId).catch(()=>null);
    if(String(snap?.location||'').includes(String(value)))return snap.location;
    await sleep(500);
  }
  return null;
}

async function setAmazonLocation(tabId,{domain,locationType,locationValue,marketName}){
  if(!validLocation(locationType,locationValue)){
    throw new Error('Invalid '+(locationType==='postal_code'?'ZIP code':'pincode')+': '+locationValue);
  }

  const origin=domainOrigin(domain);
  await navigate(tabId,origin+'/');
  const snap=await amazonSnapshot(tabId);
  if((snap.bodyChars||0)<100)throw new Error((marketName||'Amazon')+' homepage did not load normally.');
  if(String(snap.location||'').includes(String(locationValue)))return snap.location;

  await attachDebugger(tabId);
  try{
    let button=null;
    for(let i=0;i<12&&!button;i++){
      button=await findLocationButton(tabId);
      if(!button)await sleep(500);
    }
    if(!button)throw new Error('Amazon Update location control not found.');

    await realClick(tabId,button.x,button.y);

    let ui=null;
    for(let attempt=0;attempt<30&&!ui;attempt++){
      await sleep(500);
      ui=await findLocationControls(tabId);
      if(!ui&&(attempt===7||attempt===15)){
        const again=await findLocationButton(tabId);
        if(again)await realClick(tabId,again.x,again.y);
      }
    }
    if(!ui)throw new Error('Amazon location popup did not expose the location input.');

    await realClick(tabId,ui.input.x,ui.input.y);
    await cdp(tabId,'Input.dispatchKeyEvent',{type:'keyDown',modifiers:2,key:'a',code:'KeyA',windowsVirtualKeyCode:65});
    await cdp(tabId,'Input.dispatchKeyEvent',{type:'keyUp',modifiers:2,key:'a',code:'KeyA',windowsVirtualKeyCode:65});
    await cdp(tabId,'Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
    await cdp(tabId,'Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
    await cdp(tabId,'Input.insertText',{text:String(locationValue)});
    await sleep(400);
    await realClick(tabId,ui.apply.x,ui.apply.y);

    let verified=await verifyLocation(tabId,locationValue,10000);
    if(!verified){
      const [confirm]=await chrome.scripting.executeScript({
        target:{tabId},
        func:()=>{
          const visible=el=>{
            if(!el)return false;
            const r=el.getBoundingClientRect();
            return r.width>0&&r.height>0;
          };
          const el=[
            document.querySelector('#GLUXConfirmClose'),
            document.querySelector('button[name="glowDoneButton"]'),
            document.querySelector('input[name="glowDoneButton"]'),
            ...document.querySelectorAll('.a-popover button,[role="dialog"] button')
          ].find(x=>visible(x)&&/done|continue/i.test((x.value||x.textContent||'').trim()));
          if(!el)return null;
          const r=el.getBoundingClientRect();
          return {x:r.left+r.width/2,y:r.top+r.height/2};
        }
      });
      if(confirm?.result){
        await realClick(tabId,confirm.result.x,confirm.result.y);
        verified=await verifyLocation(tabId,locationValue,5000);
      }
    }

    if(!verified){
      await chrome.tabs.reload(tabId);
      await waitTabComplete(tabId,60000);
      await sleep(1000);
      verified=await verifyLocation(tabId,locationValue,5000);
    }

    if(!verified){
      const now=await amazonSnapshot(tabId).catch(()=>({location:'unknown'}));
      throw new Error('Automatic location setup failed. Wanted '+locationValue+'; header: '+(now.location||'unknown'));
    }
    return verified;
  }finally{
    await chrome.debugger.detach({tabId}).catch(()=>{});
  }
}

async function getRankTab(domain){
  const {rankTabId}=await chrome.storage.local.get('rankTabId');
  if(rankTabId){
    const t=await chrome.tabs.get(Number(rankTabId)).catch(()=>null);
    if(t)return t;
  }
  const t=await chrome.tabs.create({url:domainOrigin(domain)+'/',active:true});
  await waitTabComplete(t.id,60000);
  await chrome.storage.local.set({rankTabId:t.id});
  return t;
}

async function scrapeKeyword(tabId,keyword,rules,context){
  let organicCounter=0,sponsoredCounter=0,absoluteCounter=0,sponsoredSeen=0;
  const found=new Map();
  const origin=domainOrigin(context.domain);

  for(let pageNum=1;pageNum<=3;pageNum++){
    await navigate(tabId,origin+'/s?k='+encodeURIComponent(keyword)+(pageNum>1?'&page='+pageNum:''));
    const snap=await amazonSnapshot(tabId);

    if((snap.bodyChars||0)<100||!Array.isArray(snap.cards)||!snap.cards.length){
      throw new Error('Amazon search did not return product cards.');
    }
    if(!String(snap.location||'').includes(String(context.locationValue))){
      throw new Error('Amazon search page lost '+context.locationValue+'. Header: '+(snap.location||'unknown'));
    }

    for(const card of snap.cards){
      absoluteCounter++;
      if(card.sponsored){sponsoredCounter++;sponsoredSeen++}else organicCounter++;

      const target=rules.find(r=>String(r.asin).toUpperCase()===card.asin);
      if(!target)continue;

      const cur=found.get(card.asin)||{
        organic_rank:null,organic_page:null,organic_absolute_position:null,
        sponsored_found:false,sponsored_position:null,sponsored_page:null,
        sponsored_absolute_position:null,total_sponsored_ads_before_organic:null
      };

      if(card.sponsored&&!cur.sponsored_found){
        cur.sponsored_found=true;
        cur.sponsored_position=sponsoredCounter;
        cur.sponsored_page=pageNum;
        cur.sponsored_absolute_position=absoluteCounter;
      }else if(!card.sponsored&&cur.organic_rank===null){
        cur.organic_rank=organicCounter;
        cur.organic_page=pageNum;
        cur.organic_absolute_position=absoluteCounter;
        cur.total_sponsored_ads_before_organic=sponsoredSeen;
      }
      found.set(card.asin,cur);
    }

    const allComplete=rules.every(r=>{
      const x=found.get(String(r.asin).toUpperCase());
      return x?.organic_rank!=null&&x?.sponsored_found===true;
    });
    if(allComplete)break;
    await sleep(700);
  }

  return rules.map(rule=>{
    const x=found.get(String(rule.asin).toUpperCase())||{};
    return {
      rule_id:rule.rule_id,
      market_key:context.marketKey,
      asin:rule.asin,keyword:rule.keyword,
      location_type:context.locationType,
      location_value:context.locationValue,
      pincode:context.locationValue,
      device:rule.device,
      checked_at:new Date().toISOString(),status:'SUCCESS',
      organic_rank:x.organic_rank??null,organic_page:x.organic_page??null,
      organic_absolute_position:x.organic_absolute_position??null,
      sponsored_found:!!x.sponsored_found,sponsored_position:x.sponsored_position??null,
      sponsored_page:x.sponsored_page??null,sponsored_absolute_position:x.sponsored_absolute_position??null,
      total_sponsored_ads_before_organic:x.total_sponsored_ads_before_organic??null,
      total_results_scanned:absoluteCounter
    };
  });
}

async function releaseRequest(conf,reason){
  if(!conf?.request_id)return;
  await api('local_worker_release',{
    method:'POST',
    body:{request_id:conf.request_id,reason:String(reason||'Worker setup failed.')}
  }).catch(()=>{});
}

async function runCheck(force=false){
  if(running)return {ok:false,message:'Already running'};
  if(!force){
    const {retryAfter=0}=await chrome.storage.local.get('retryAfter');
    if(Number(retryAfter)>Date.now())return {ok:true,backoff:true};
  }

  running=true;
  let conf=null,rankTab=null,previousActive=null;

  try{
    const [active]=await chrome.tabs.query({active:true,currentWindow:true});
    previousActive=active||null;

    await setStatus('Checking queue…',{lastError:null});
    conf=await api('local_worker_config',{force});

    if(conf.mode==='skip'){
      await setStatus('Idle — waiting for next market schedule.',{
        lastPollAt:new Date().toISOString()
      });
      return {ok:true,skipped:true};
    }

    if(!Array.isArray(conf.rules)||!conf.rules.length)throw new Error('No active tracking rules for '+(conf.market_name||conf.market_key||'market')+'.');

    const context={
      marketKey:String(conf.market_key||'IN'),
      marketName:String(conf.market_name||conf.market_key||'Amazon'),
      domain:String(conf.domain||'www.amazon.in'),
      locationType:String(conf.location_type||'pincode'),
      locationValue:String(conf.location_value||conf.default_pincode||'')
    };
    if(!validLocation(context.locationType,context.locationValue)){
      throw new Error(context.marketName+' location is not configured correctly.');
    }

    rankTab=await getRankTab(context.domain);
    await chrome.tabs.update(rankTab.id,{active:true});

    await setStatus('Setting '+context.marketName+' '+context.locationValue+'…');
    const location=await setAmazonLocation(rankTab.id,{
      domain:context.domain,
      locationType:context.locationType,
      locationValue:context.locationValue,
      marketName:context.marketName
    });
    await setStatus('Verified '+location+'. Checking '+context.marketName+' keywords…');

    const results=[];
    const byKeyword=new Map();
    for(const r of conf.rules){
      if(!byKeyword.has(r.keyword))byKeyword.set(r.keyword,[]);
      byKeyword.get(r.keyword).push(r);
    }

    for(const [keyword,rr] of byKeyword){
      try{
        await setStatus(context.marketName+': '+keyword+'…');
        results.push(...await scrapeKeyword(rankTab.id,keyword,rr,context));
      }catch(e){
        const msg=e?.message||String(e);
        results.push(...rr.map(r=>({
          rule_id:r.rule_id,market_key:context.marketKey,
          asin:r.asin,keyword:r.keyword,
          location_type:context.locationType,
          location_value:context.locationValue,
          pincode:context.locationValue,
          device:r.device,checked_at:new Date().toISOString(),
          status:'FAILED',error:msg
        })));
      }
    }

    const runId='opera-'+context.marketKey.toLowerCase()+'-'+Date.now();
    const stored=await api('local_worker_ingest',{
      method:'POST',
      body:{
        run_id:runId,
        market_key:context.marketKey,
        location_value:context.locationValue,
        mode:conf.mode,
        request_id:conf.request_id||null,
        provider:'browser-extension',
        provider_name:'Zipify Opera Rank Extension',
        results
      }
    });

    await chrome.storage.local.remove('retryAfter');

    if(Array.isArray(stored.alerts)&&stored.alerts.length){
      for(const a of stored.alerts.slice(0,5)){
        const isRecovery=String(a.severity||'')==='recovery';
        await chrome.notifications.create('zipify-rank-'+String(a.id||Date.now())+'-'+Math.random(),{
          type:'basic',
          iconUrl:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="24" fill="%23171717"/><text x="64" y="82" text-anchor="middle" font-family="Arial" font-size="64" font-weight="700" fill="white">Z</text></svg>'),
          title:String(a.title||'Zipify Rank Alert'),
          message:String(a.message||''),
          priority:isRecovery?0:2
        }).catch(()=>{});
      }
    }

    await setStatus(
      context.marketName+' completed: '+stored.success+'/'+stored.total+' successful.'+(stored.alerts?.length?' '+stored.alerts.length+' alert update(s).':''),
      {
        lastRunAt:new Date().toISOString(),
        lastSuccess:stored.success,lastFailed:stored.failed,
        lastRunId:runId,lastMarket:context.marketKey
      }
    );
    return stored;
  }catch(e){
    const msg=e?.message||String(e);
    await releaseRequest(conf,msg);
    await chrome.storage.local.set({retryAfter:Date.now()+SETUP_RETRY_MS});
    await setStatus('Automatic setup failed; retrying automatically. '+msg,{lastError:msg});
    return {ok:false,error:msg};
  }finally{
    running=false;
    if(previousActive?.id&&rankTab?.id&&previousActive.id!==rankTab.id){
      await chrome.tabs.update(previousActive.id,{active:true}).catch(()=>{});
    }
  }
}

async function ensureAlarm(){
  const a=await chrome.alarms.get(ALARM);
  if(!a||Number(a.periodInMinutes)!==POLL_MINUTES){
    if(a)await chrome.alarms.clear(ALARM);
    await chrome.alarms.create(ALARM,{delayInMinutes:0.1,periodInMinutes:POLL_MINUTES});
  }
}

async function boot(){
  await ensureAlarm();
  const token=await getToken();
  if(token)runCheck(false).catch(()=>{});
}

boot().catch(()=>{});
chrome.runtime.onInstalled.addListener(()=>boot().catch(()=>{}));
chrome.runtime.onStartup.addListener(()=>boot().catch(()=>{}));
chrome.alarms.onAlarm.addListener(a=>{
  if(a.name===ALARM)runCheck(false).catch(()=>{});
});

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg?.type==='runNow'){
    runCheck(true).then(r=>sendResponse(r)).catch(e=>sendResponse({ok:false,error:e?.message||String(e)}));
    return true;
  }
  if(msg?.type==='ensureAlarm'){
    ensureAlarm().then(()=>sendResponse({ok:true,version:EXT_VERSION}));
    return true;
  }
});