const EXT_VERSION='2026.09.29.59-safe-window-v1';
const API='https://ywrtgkdkntjyeqdnrbop.supabase.co/functions/v1/rank-intelligence';
const ALARM='rank-poll';
const POLL_MINUTES=2;
const SETUP_RETRY_MS=120000;
let running=false;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getToken(){
  const {token=''}=await chrome.storage.local.get('token');
  return String(token||'').trim();
}

async function setStatus(status,extra={}){
  const payload={status,updatedAt:new Date().toISOString(),extensionVersion:EXT_VERSION,...extra};
  await chrome.storage.local.set(payload);
  try{
    const statusEl=document.getElementById('status');
    const buildEl=document.getElementById('build');
    const updatedEl=document.getElementById('updated');
    if(statusEl)statusEl.textContent=String(status||'');
    if(buildEl)buildEl.textContent=EXT_VERSION;
    if(updatedEl)updatedEl.textContent=new Date(payload.updatedAt).toLocaleString();
  }catch{}
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

async function documentProbe(tabId){
  const [res]=await chrome.scripting.executeScript({
    target:{tabId},
    func:()=>({
      url:location.href,
      readyState:document.readyState,
      timeOrigin:Number(performance.timeOrigin||0)
    })
  }).catch(()=>[null]);
  return res?.result||null;
}

async function waitTabComplete(tabId,timeout=60000,options={}){
  const expectedUrl=String(options.expectedUrl||'');
  const previousTimeOrigin=Number(options.previousTimeOrigin||0);
  const startedAt=Date.now();
  let expected=null;
  try{ if(expectedUrl) expected=new URL(expectedUrl); }catch{}

  while(Date.now()-startedAt<timeout){
    const tab=await chrome.tabs.get(tabId).catch(()=>null);
    const probe=await documentProbe(tabId).catch(()=>null);

    if(tab && probe && probe.readyState==='complete'){
      let urlOk=true;
      if(expected){
        try{
          const got=new URL(probe.url||tab.url||'');
          const expectedRoot=expected.hostname.replace(/^www\./i,'').toLowerCase();
          const gotRoot=got.hostname.replace(/^www\./i,'').toLowerCase();
          urlOk=gotRoot===expectedRoot;
          if(urlOk && expected.pathname.startsWith('/s')){
            urlOk=got.pathname.startsWith('/s');
          }
        }catch{urlOk=false}
      }

      const changed=!previousTimeOrigin || Number(probe.timeOrigin||0)!==previousTimeOrigin;
      if(urlOk && changed)return tab;
    }
    await sleep(200);
  }
  throw new Error('Amazon navigation timed out before a fresh document finished loading.');
}

async function dismissContinueShopping(tabId){
  const probe=async(click=false)=>{
    const [res]=await chrome.scripting.executeScript({
      target:{tabId},
      func:(shouldClick)=>{
        const body=(document.body?.innerText||'').replace(/\s+/g,' ').trim();
        const challenge=/click the button below to continue shopping/i.test(body);
        if(!challenge)return {challenge:false,found:false,clicked:false};

        const visible=el=>{
          if(!el)return false;
          const r=el.getBoundingClientRect();
          const s=getComputedStyle(el);
          return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';
        };
        const label=el=>String(el?.value||el?.textContent||el?.getAttribute('aria-label')||'')
          .replace(/\s+/g,' ').trim();
        const candidates=[
          ...document.querySelectorAll('button,input[type="submit"],input[type="button"],a')
        ].filter(visible);
        const button=candidates.find(el=>/^continue shopping$/i.test(label(el)))
          ||candidates.find(el=>/continue shopping/i.test(label(el)));
        if(!button)return {challenge:true,found:false,clicked:false};

        const r=button.getBoundingClientRect();
        if(shouldClick)button.click();
        return {
          challenge:true,found:true,clicked:!!shouldClick,
          x:r.left+r.width/2,y:r.top+r.height/2
        };
      },
      args:[click]
    }).catch(()=>[null]);
    return res?.result||{challenge:true,found:false,clicked:false};
  };

  for(let attempt=0;attempt<8;attempt++){
    let state=await probe(true);
    if(!state.challenge)return false;
    if(!state.found){
      await sleep(500);
      continue;
    }

    // Normal DOM submit works on most Amazon interstitials.
    await sleep(800);
    let after=await probe(false);
    if(!after.challenge){
      await waitTabComplete(tabId,30000).catch(()=>{});
      await sleep(500);
      return true;
    }

    // Fallback to a real browser mouse click if Amazon ignores a synthetic click.
    try{
      await attachDebugger(tabId);
      const target=after.found?after:state;
      await realClick(tabId,target.x,target.y);
    }catch{}finally{
      await chrome.debugger.detach({tabId}).catch(()=>{});
    }

    await sleep(900);
    await waitTabComplete(tabId,30000).catch(()=>{});
    after=await probe(false);
    if(!after.challenge){
      await sleep(500);
      return true;
    }
  }
  throw new Error('Amazon Continue shopping screen could not be dismissed automatically.');
}
async function navigate(tabId,url){
  const before=await documentProbe(tabId).catch(()=>null);
  await chrome.tabs.update(tabId,{url,active:true});
  await waitTabComplete(tabId,60000,{
    expectedUrl:url,
    previousTimeOrigin:Number(before?.timeOrigin||0)
  });
  await sleep(700);
  await dismissContinueShopping(tabId);
  await sleep(400);

  const after=await documentProbe(tabId).catch(()=>null);
  if(!after || after.readyState!=='complete'){
    throw new Error('Amazon navigation completed without a stable document.');
  }
}

async function amazonSnapshot(tabId){
  const results=await chrome.scripting.executeScript({
    target:{tabId},
    func:()=>{
      const body=(document.body?.innerText||'').trim();
      const line1=(document.querySelector('#glow-ingress-line1')?.textContent||'').trim();
      const line2=(document.querySelector('#glow-ingress-line2')?.textContent||'').trim();
      const locationText=(line1+' '+line2).replace(/\s+/g,' ').trim();

      const hrefAsin=href=>{
        const m=String(href||'').match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
        return m?String(m[1]).toUpperCase():null;
      };

      const cards=[...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')]
        .map((el,index)=>{
          const asin=(el.getAttribute('data-asin')||'').trim().toUpperCase();
          const titleLink=
            el.querySelector('h2 a[href*="/dp/"],h2 a[href*="/gp/product/"]') ||
            el.querySelector('a.a-link-normal[href*="/dp/"]');
          const titleAsin=hrefAsin(titleLink?.href||titleLink?.getAttribute('href')||'');
          const text=(el.textContent||'').replace(/\s+/g,' ').trim();
          const sponsored=/\bSponsored\b/i.test(text) ||
            !!el.querySelector('[aria-label*="Sponsored"],[data-component-type="sp-sponsored-result"],[class*="s-sponsored"]');
          const asins=[asin,titleAsin].filter(Boolean);
          return {asin,titleAsin,asins:[...new Set(asins)],sponsored,absolute:index+1};
        }).filter(x=>x.asins.length);

      const u=new URL(window.location.href);
      const searchTerm=(u.searchParams.get('k')||'').replace(/\+/g,' ').trim();
      const low=body.toLowerCase();
      const blocked=
        /sorry, we just need to make sure you're not a robot/i.test(body) ||
        /enter the characters you see below/i.test(body) ||
        /type the characters you see in this image/i.test(body) ||
        low.includes('automated access to amazon data');
      const continueShopping=/click the button below to continue shopping/i.test(body);

      const uniqueAsinCount=new Set(cards.flatMap(c=>c.asins||[])).size;
      const pageParam=u.searchParams.get('page');
      const timeOrigin=Number(performance.timeOrigin||0);
      const snapshotAt=Date.now();
      const pageSignature=[
        u.hostname,u.pathname,searchTerm,pageParam||'1',
        String(timeOrigin),
        cards.slice(0,8).map(c=>(c.asins||[]).join(':')+(c.sponsored?'S':'O')).join('|')
      ].join('::');

      return {
        title:document.title,
        url:window.location.href,
        path:u.pathname,
        hostname:u.hostname,
        searchTerm,
        pageParam,
        bodyChars:body.length,
        location:locationText,
        cards,
        uniqueAsinCount,
        blocked,
        continueShopping,
        readyState:document.readyState,
        timeOrigin,
        snapshotAt,
        pageSignature
      };
    }
  });

  const res=results?.[0];
  if(res?.error){
    throw new Error('Amazon snapshot script failed: '+String(res.error.message||res.error));
  }
  if(!res || !res.result || !res.result.hostname){
    throw new Error('Amazon snapshot returned no document identity.');
  }
  return res.result;
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

async function clearAmazonSession(domain,tabId){
  const origin=domainOrigin(domain);
  const host=new URL(origin).hostname;
  const root=host.replace(/^www\./i,'');
  const amazonRoots=[...new Set([root,'amazon.in','amazon.com'])];

  // Clear only Amazon data in the cookie store used by this private tab.
  let privateStoreId=null;
  const stores=await chrome.cookies.getAllCookieStores().catch(()=>[]);
  for(const store of stores||[]){
    if(Array.isArray(store.tabIds)&&store.tabIds.includes(Number(tabId))){
      privateStoreId=store.id;
      break;
    }
  }

  const cookieQuery=privateStoreId?{storeId:privateStoreId}:{};
  const cookies=await chrome.cookies.getAll(cookieQuery).catch(()=>[]);
  for(const c of cookies){
    const d=String(c.domain||'').replace(/^\./,'').toLowerCase();
    if(!amazonRoots.some(r=>d===r || d.endsWith('.'+r)))continue;
    const scheme=c.secure?'https://':'http://';
    const cookieHost=String(c.domain||root).replace(/^\./,'');
    await chrome.cookies.remove({
      url:scheme+cookieHost+(c.path||'/'),
      name:c.name,
      storeId:c.storeId
    }).catch(()=>{});
  }

  // Clear HTTP cache plus all origin storage (local/session storage, IndexedDB,
  // CacheStorage, service workers, etc.) before Amazon is opened for this run.
  await attachDebugger(tabId);
  try{
    await cdp(tabId,'Network.enable').catch(()=>{});
    await cdp(tabId,'Network.clearBrowserCache').catch(()=>{});
    for(const r of amazonRoots){
      for(const o of ['https://'+r,'https://www.'+r]){
        await cdp(tabId,'Storage.clearDataForOrigin',{
          origin:o,
          storageTypes:'all'
        }).catch(()=>{});
      }
    }
  }finally{
    await chrome.debugger.detach({tabId}).catch(()=>{});
  }

  await chrome.storage.local.set({
    lastAmazonSessionResetAt:new Date().toISOString(),
    lastAmazonSessionResetDomain:root,
    lastAmazonSessionResetStoreId:privateStoreId||null
  });
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
  const expectedRoot=new URL(origin).hostname.replace(/^www\./i,'').toLowerCase();
  const gotRoot=String(snap.hostname||'').replace(/^www\./i,'').toLowerCase();

  if(gotRoot!==expectedRoot){
    throw new Error((marketName||'Amazon')+' opened the wrong domain: '+(snap.hostname||snap.url||'unknown'));
  }
  if(snap.continueShopping){
    throw new Error((marketName||'Amazon')+' Continue shopping interstitial remained after bootstrap.');
  }
  if(snap.blocked){
    throw new Error((marketName||'Amazon')+' verification/challenge page blocked bootstrap.');
  }
  if(snap.readyState!=='complete'){
    throw new Error((marketName||'Amazon')+' homepage document was not complete.');
  }
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

async function closePreviousRankWindow(){
  const {rankWindowId,rankTabId}=await chrome.storage.local.get(['rankWindowId','rankTabId']);

  if(rankWindowId && rankTabId){
    const tab=await chrome.tabs.get(Number(rankTabId)).catch(()=>null);

    // Never trust a persisted window id by itself. Browser window ids can be
    // reused after restarts. Only close the stored window when the exact stored
    // rank tab still exists, belongs to that window, and is actually incognito.
    if(
      tab?.id &&
      Number(tab.windowId)===Number(rankWindowId) &&
      tab.incognito===true
    ){
      await chrome.windows.remove(Number(rankWindowId)).catch(()=>{});
    }
  }

  await chrome.storage.local.remove(['rankTabId','rankWindowId']);
}

async function getRankTab(domain){
  const allowed=await chrome.extension.isAllowedIncognitoAccess();
  if(!allowed){
    throw new Error('Enable "Allow in incognito" for Zipify Multi-Market Rank Agent in opera://extensions.');
  }

  // Never reuse an earlier rank-agent window. Each run starts from a new,
  // disposable private browser window.
  await closePreviousRankWindow();

  const w=await chrome.windows.create({
    url:'about:blank',
    incognito:true,
    focused:true,
    type:'normal'
  });
  const t=(w.tabs||[])[0];
  if(!t?.id)throw new Error('Could not create fresh private Amazon rank window.');
  if(!w.incognito || !t.incognito){
    await chrome.windows.remove(w.id).catch(()=>{});
    throw new Error('Opera created a normal window instead of a private window.');
  }

  const verifiedTab=await chrome.tabs.get(t.id).catch(()=>null);
  if(!verifiedTab?.incognito){
    await chrome.windows.remove(w.id).catch(()=>{});
    throw new Error('Opera did not confirm the new rank window as private/incognito.');
  }

  await chrome.storage.local.set({
    rankTabId:t.id,
    rankWindowId:w.id,
    lastPrivateWindowVerifiedAt:new Date().toISOString(),
    lastFreshRankWindowAt:new Date().toISOString()
  });
  return verifiedTab;
}


async function scrapeKeyword(tabId,keyword,rules,context,sessionMeta={}){
  const origin=domainOrigin(context.domain);
  const normalizedKeyword=String(keyword||'').trim().toLowerCase().replace(/\s+/g,' ');
  const expectedRoot=new URL(origin).hostname.replace(/^www\./i,'').toLowerCase();
  const maxPages=Math.max(1,Math.min(10,Number(context.maxPages||5)));
  const sessionId=String(sessionMeta.sessionId||crypto.randomUUID());
  const startedAt=String(sessionMeta.startedAt||new Date().toISOString());

  let organicCounter=0,sponsoredCounter=0,absoluteCounter=0,sponsoredSeen=0,pages=0;
  let previousTimeOrigin=null;
  const pageSignatures=new Set();
  const found=new Map();

  for(let pageNum=1;pageNum<=maxPages;pageNum++){
    const url=origin+'/s?k='+encodeURIComponent(keyword)+(pageNum>1?'&page='+pageNum:'');
    const navigationStartedAt=Date.now();
    await navigate(tabId,url);
    const snap=await amazonSnapshot(tabId);
    pages++;

    if(snap.continueShopping){
      throw new Error('Amazon Continue shopping interstitial remained after navigation.');
    }
    if(snap.blocked){
      throw new Error('Amazon blocked or challenged the automated search page.');
    }

    const gotRoot=String(snap.hostname||'').replace(/^www\./i,'').toLowerCase();
    if(gotRoot!==expectedRoot){
      throw new Error('Amazon market/domain changed. Expected '+expectedRoot+', got '+(snap.hostname||'unknown')+'.');
    }

    if(snap.readyState!=='complete'){
      throw new Error('Amazon search page was not fully loaded.');
    }
    if((snap.bodyChars||0)<500 || !Array.isArray(snap.cards) || snap.cards.length<8 || Number(snap.uniqueAsinCount||0)<6){
      throw new Error('Amazon search page was incomplete or invalid: '+(snap.cards?.length||0)+' cards / '+(snap.uniqueAsinCount||0)+' unique ASINs.');
    }
    if(!String(snap.location||'').includes(String(context.locationValue))){
      throw new Error('Amazon search page lost '+context.locationValue+'. Header: '+(snap.location||'unknown'));
    }

    const gotKeyword=String(snap.searchTerm||'').trim().toLowerCase().replace(/\s+/g,' ');
    if(!String(snap.path||'').startsWith('/s') || gotKeyword!==normalizedKeyword){
      throw new Error('Amazon returned the wrong search page. Expected “'+keyword+'”, got “'+(snap.searchTerm||snap.url||'unknown')+'”.');
    }

    const gotPage=Number(snap.pageParam||1);
    if(gotPage!==pageNum){
      throw new Error('Amazon returned stale/wrong pagination. Expected page '+pageNum+', got page '+gotPage+'.');
    }

    const timeOrigin=Number(snap.timeOrigin||0);
    if(timeOrigin){
      if(previousTimeOrigin!==null && timeOrigin===previousTimeOrigin){
        throw new Error('Stale Amazon document detected: navigation time did not change.');
      }
      if(Math.abs(timeOrigin-navigationStartedAt)>120000){
        throw new Error('Stale Amazon page detected: document predates this navigation.');
      }
      previousTimeOrigin=timeOrigin;
    }

    const snapshotAt=Number(snap.snapshotAt||0);
    if(!snapshotAt || Math.abs(Date.now()-snapshotAt)>30000){
      throw new Error('Amazon page timestamp validation failed.');
    }
    const signature=String(snap.pageSignature||'');
    if(!signature || pageSignatures.has(signature)){
      throw new Error('Duplicate/stale Amazon SERP page detected.');
    }
    pageSignatures.add(signature);

    for(const card of snap.cards){
      absoluteCounter++;
      if(card.sponsored){sponsoredCounter++;sponsoredSeen++}else organicCounter++;

      const matched=rules.filter(r=>{
        const target=String(r.asin||'').toUpperCase();
        return Array.isArray(card.asins) && card.asins.includes(target);
      });
      if(!matched.length)continue;

      for(const target of matched){
        const key=String(target.asin).toUpperCase();
        const cur=found.get(key)||{
          organic_rank:null,organic_page:null,organic_absolute_position:null,
          sponsored_found:false,sponsored_position:null,sponsored_page:null,
          sponsored_absolute_position:null,total_sponsored_ads_before_organic:null
        };

        if(card.sponsored && !cur.sponsored_found){
          cur.sponsored_found=true;
          cur.sponsored_position=sponsoredCounter;
          cur.sponsored_page=pageNum;
          cur.sponsored_absolute_position=absoluteCounter;
        }else if(!card.sponsored && cur.organic_rank===null){
          cur.organic_rank=organicCounter;
          cur.organic_page=pageNum;
          cur.organic_absolute_position=absoluteCounter;
          cur.total_sponsored_ads_before_organic=sponsoredSeen;
        }
        found.set(key,cur);
      }
    }

    const allComplete=rules.every(r=>{
      const x=found.get(String(r.asin).toUpperCase());
      return context.mode==='full'
        ? x?.organic_rank!=null && x?.sponsored_found===true
        : x?.sponsored_found===true;
    });
    if(allComplete)break;
    await sleep(650);
  }

  const completedAt=new Date().toISOString();
  return rules.map(rule=>{
    const key=String(rule.asin).toUpperCase();
    const x=found.get(key)||{};
    const organicChecked=context.mode==='full';
    const organicFound=organicChecked ? x.organic_rank!=null : null;
    const sponsoredFound=!!x.sponsored_found;

    return {
      rule_id:rule.rule_id,
      market_key:context.marketKey,
      asin:rule.asin,keyword:rule.keyword,
      location_type:context.locationType,
      location_value:context.locationValue,
      pincode:context.locationValue,
      device:rule.device,
      checked_at:completedAt,
      status:'SUCCESS',
      result_state:organicChecked && organicFound ? 'FOUND' : 'UNVERIFIED',

      organic_checked:organicChecked,
      organic_found:organicFound,
      organic_rank:organicFound?(x.organic_rank??null):null,
      organic_page:organicFound?(x.organic_page??null):null,
      organic_absolute_position:organicFound?(x.organic_absolute_position??null):null,
      total_sponsored_ads_before_organic:organicFound?(x.total_sponsored_ads_before_organic??null):null,

      sponsored_checked:true,
      sponsored_found:sponsoredFound,
      sponsored_position:sponsoredFound?(x.sponsored_position??null):null,
      sponsored_page:sponsoredFound?(x.sponsored_page??null):null,
      sponsored_absolute_position:sponsoredFound?(x.sponsored_absolute_position??null):null,

      scan_state:organicChecked
        ? (organicFound?'valid_found':'valid_not_found_single_clean_session')
        : 'valid_sponsored_only',
      confidence_score:organicChecked?(organicFound?97:70):80,
      verification_sessions:1,
      verification_session_ids:[sessionId],
      session_page_counts:[pages],
      verification_passes:1,
      page_count:pages,
      total_results_scanned:absoluteCounter,
      browser_session_id:sessionId,
      search_started_at:startedAt,
      search_completed_at:completedAt
    };
  });
}

async function closeRankSession(tab){
  if(tab?.windowId){
    await chrome.windows.remove(tab.windowId).catch(()=>{});
  }
  await chrome.storage.local.remove(['rankTabId','rankWindowId']);
}

async function openCleanRankSession(context){
  const sessionId=crypto.randomUUID();
  const startedAt=new Date().toISOString();

  const tab=await getRankTab(context.domain);
  await chrome.tabs.update(tab.id,{active:true});

  await setStatus('Clearing Amazon cookies, cache and site storage…');
  await clearAmazonSession(context.domain,tab.id);

  await setStatus('Opening a clean '+context.marketName+' session and setting location…');

  const location=await setAmazonLocation(tab.id,{
    domain:context.domain,
    locationType:context.locationType,
    locationValue:context.locationValue,
    marketName:context.marketName
  });

  const snap=await amazonSnapshot(tab.id);
  const expectedRoot=new URL(domainOrigin(context.domain)).hostname.replace(/^www\./i,'').toLowerCase();
  const gotRoot=String(snap.hostname||'').replace(/^www\./i,'').toLowerCase();
  if(gotRoot!==expectedRoot)throw new Error('Clean session opened the wrong Amazon market/domain.');
  if(snap.blocked||snap.continueShopping)throw new Error('Clean Amazon session is still on a verification/interstitial page.');
  if(!String(snap.location||'').includes(String(context.locationValue))){
    throw new Error('Clean Amazon session did not retain '+context.locationValue+'.');
  }

  return {tab,sessionId,startedAt,location};
}

async function preflightMarket(context){
  let session=null;
  try{
    await setStatus(context.marketName+': validating clean private Amazon session…');
    session=await openCleanRankSession(context);
    const snap=await amazonSnapshot(session.tab.id);
    const expectedRoot=new URL(domainOrigin(context.domain)).hostname.replace(/^www\./i,'').toLowerCase();
    const gotRoot=String(snap.hostname||'').replace(/^www\./i,'').toLowerCase();

    if(gotRoot!==expectedRoot){
      throw new Error('Preflight opened wrong Amazon domain: '+(snap.hostname||'unknown'));
    }
    if(snap.blocked||snap.continueShopping){
      throw new Error('Preflight is blocked by an Amazon verification/interstitial page.');
    }
    if(!String(snap.location||'').includes(String(context.locationValue))){
      throw new Error('Preflight location verification failed. Wanted '+context.locationValue+'; header: '+(snap.location||'unknown'));
    }
    return true;
  }finally{
    if(session?.tab)await closeRankSession(session.tab);
    else await closePreviousRankWindow().catch(()=>{});
  }
}

async function runKeywordReliably(keyword,rules,context){
  const maxAttempts=context.mode==='full'?3:2;
  const evidence=new Map(rules.map(r=>[Number(r.rule_id),{valid:[],errors:[]}]));

  const resolved=rule=>{
    const ev=evidence.get(Number(rule.rule_id));
    if(!ev)return false;
    if(context.mode!=='full')return ev.valid.length>=1;
    if(ev.valid.some(x=>x.organic_found===true))return true;
    return ev.valid.filter(x=>x.organic_found===false).length>=2;
  };

  for(let attempt=1;attempt<=maxAttempts;attempt++){
    const pending=rules.filter(r=>!resolved(r));
    if(!pending.length)break;

    let session=null;
    try{
      await setStatus(
        context.marketName+': '+keyword+' — clean session '+attempt+'/'+maxAttempts+
        (attempt>1?' verification':'')
      );
      session=await openCleanRankSession(context);
      const observations=await scrapeKeyword(
        session.tab.id,keyword,pending,
        {...context,sessionId:session.sessionId},
        session
      );
      for(const o of observations){
        const ev=evidence.get(Number(o.rule_id));
        if(ev)ev.valid.push(o);
      }
    }catch(e){
      const msg=e?.message||String(e);
      for(const r of pending){
        const ev=evidence.get(Number(r.rule_id));
        if(ev)ev.errors.push('Session '+attempt+': '+msg);
      }
    }finally{
      if(session?.tab)await closeRankSession(session.tab);
      else await closePreviousRankWindow().catch(()=>{});
    }
  }

  return rules.map(rule=>{
    const ev=evidence.get(Number(rule.rule_id))||{valid:[],errors:[]};
    const valid=ev.valid||[];
    const sessionIds=[...new Set(valid.flatMap(x=>x.verification_session_ids||[x.browser_session_id]).filter(Boolean).map(String))];
    const pageCounts=valid.map(x=>Number(x.page_count||0));
    const totalPages=pageCounts.reduce((a,b)=>a+b,0);
    const totalScanned=valid.reduce((a,x)=>a+Number(x.total_results_scanned||0),0);
    const latest=valid[valid.length-1]||null;
    const sponsoredObs=[...valid].reverse().find(x=>x.sponsored_found===true)||latest;
    const foundObs=[...valid].reverse().find(x=>x.organic_found===true)||null;
    const notFoundObs=valid.filter(x=>x.organic_found===false);

    if(foundObs){
      return {
        ...foundObs,
        sponsored_found:!!sponsoredObs?.sponsored_found,
        sponsored_position:sponsoredObs?.sponsored_found?(sponsoredObs.sponsored_position??null):null,
        sponsored_page:sponsoredObs?.sponsored_found?(sponsoredObs.sponsored_page??null):null,
        sponsored_absolute_position:sponsoredObs?.sponsored_found?(sponsoredObs.sponsored_absolute_position??null):null,
        result_state:'FOUND',
        scan_state:valid.length>1?'valid_found_after_clean_retry':'valid_found',
        confidence_score:valid.length>1?99:97,
        verification_sessions:sessionIds.length,
        verification_session_ids:sessionIds,
        session_page_counts:pageCounts,
        verification_passes:valid.length,
        page_count:totalPages,
        total_results_scanned:totalScanned,
        browser_session_id:foundObs.browser_session_id||sessionIds[sessionIds.length-1]||null,
        search_started_at:valid[0]?.search_started_at||foundObs.search_started_at,
        search_completed_at:foundObs.search_completed_at||foundObs.checked_at
      };
    }

    if(context.mode!=='full' && latest){
      return {
        ...latest,
        result_state:'UNVERIFIED',
        scan_state:'valid_sponsored_only',
        confidence_score:80,
        verification_sessions:sessionIds.length,
        verification_session_ids:sessionIds,
        session_page_counts:pageCounts,
        verification_passes:valid.length,
        page_count:totalPages,
        total_results_scanned:totalScanned
      };
    }

    if(notFoundObs.length>=2 && sessionIds.length>=2){
      return {
        ...latest,
        status:'SUCCESS',
        result_state:'CONFIRMED_NOT_FOUND',
        organic_checked:true,
        organic_found:false,
        organic_rank:null,
        organic_page:null,
        organic_absolute_position:null,
        total_sponsored_ads_before_organic:null,
        sponsored_found:!!sponsoredObs?.sponsored_found,
        sponsored_position:sponsoredObs?.sponsored_found?(sponsoredObs.sponsored_position??null):null,
        sponsored_page:sponsoredObs?.sponsored_found?(sponsoredObs.sponsored_page??null):null,
        sponsored_absolute_position:sponsoredObs?.sponsored_found?(sponsoredObs.sponsored_absolute_position??null):null,
        scan_state:'valid_not_found_independent_confirmed',
        confidence_score:99,
        verification_sessions:sessionIds.length,
        verification_session_ids:sessionIds,
        session_page_counts:pageCounts,
        verification_passes:valid.length,
        page_count:totalPages,
        total_results_scanned:totalScanned,
        browser_session_id:sessionIds[sessionIds.length-1]||null,
        search_started_at:valid[0]?.search_started_at||null,
        search_completed_at:latest?.search_completed_at||latest?.checked_at||new Date().toISOString()
      };
    }

    if(notFoundObs.length===1){
      const one=notFoundObs[0];
      return {
        ...one,
        status:'SUCCESS',
        result_state:'UNVERIFIED',
        scan_state:'valid_not_found_unverified',
        confidence_score:60,
        verification_sessions:sessionIds.length,
        verification_session_ids:sessionIds,
        session_page_counts:pageCounts,
        verification_passes:valid.length,
        page_count:totalPages,
        total_results_scanned:totalScanned,
        error:'Could not obtain a second independent clean verification. '+(ev.errors||[]).join(' | ')
      };
    }

    return {
      rule_id:rule.rule_id,
      market_key:context.marketKey,
      asin:rule.asin,
      keyword:rule.keyword,
      location_type:context.locationType,
      location_value:context.locationValue,
      pincode:context.locationValue,
      device:rule.device,
      checked_at:new Date().toISOString(),
      status:'FAILED',
      result_state:'FAILED',
      organic_checked:false,
      organic_found:null,
      sponsored_checked:false,
      sponsored_found:null,
      scan_state:'failed',
      confidence_score:0,
      verification_sessions:0,
      verification_session_ids:[],
      session_page_counts:[],
      verification_passes:0,
      page_count:0,
      total_results_scanned:0,
      error:(ev.errors||[]).join(' | ')||'No clean verified Amazon session completed.'
    };
  });
}

async function releaseRequest(conf,reason){
  if(!conf?.request_id&&!conf?.job_id)return;
  await api('local_worker_release',{
    method:'POST',
    body:{
      job_id:conf?.job_id||null,
      request_id:conf?.request_id||null,
      reason:String(reason||'Worker setup failed.')
    }
  }).catch(()=>{});
}

async function runCheck(force=false){
  if(running)return {ok:false,message:'Already running'};
  if(!force){
    const {retryAfter=0}=await chrome.storage.local.get('retryAfter');
    if(Number(retryAfter)>Date.now())return {ok:true,backoff:true};
  }

  running=true;
  let conf=null,previousActive=null,heartbeatTimer=null;
  let currentStage='starting';

  const renewLease=async(stage=currentStage)=>{
    if(!conf?.job_id)return null;
    currentStage=String(stage||currentStage||'running');
    return api('local_worker_heartbeat',{
      method:'POST',
      body:{job_id:conf.job_id,stage:currentStage}
    });
  };

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

    if(!Array.isArray(conf.rules)||!conf.rules.length){
      throw new Error('No active tracking rules for '+(conf.market_name||conf.market_key||'market')+'.');
    }

    await renewLease('claimed');
    heartbeatTimer=setInterval(()=>renewLease(currentStage).catch(()=>{}),30000);

    const context={
      marketKey:String(conf.market_key||'IN'),
      marketName:String(conf.market_name||conf.market_key||'Amazon'),
      domain:String(conf.domain||'www.amazon.in'),
      locationType:String(conf.location_type||'pincode'),
      locationValue:String(conf.location_value||conf.default_pincode||''),
      mode:String(conf.mode||'full'),
      maxPages:Math.max(1,Math.min(10,Number(conf.max_search_pages||5)))
    };
    if(!validLocation(context.locationType,context.locationValue)){
      throw new Error(context.marketName+' location is not configured correctly.');
    }

    // Fail fast before the keyword loop. A broken browser/bootstrap state should
    // never open/close three windows for every keyword.
    await renewLease('preflight');
    await preflightMarket(context);

    const results=[];
    const byKeyword=new Map();
    for(const r of conf.rules){
      if(!byKeyword.has(r.keyword))byKeyword.set(r.keyword,[]);
      byKeyword.get(r.keyword).push(r);
    }

    let keywordIndex=0;
    for(const [keyword,rr] of byKeyword){
      keywordIndex++;
      currentStage='keyword '+keywordIndex+'/'+byKeyword.size+': '+keyword;
      await renewLease(currentStage);
      await setStatus(
        context.marketName+': '+keyword+' ('+keywordIndex+'/'+byKeyword.size+') — starting clean verification…'
      );
      const keywordResults=await runKeywordReliably(keyword,rr,context);
      results.push(...keywordResults);
    }

    await renewLease('uploading results');
    const runId='opera-'+context.marketKey.toLowerCase()+'-'+Date.now();
    const stored=await api('local_worker_ingest',{
      method:'POST',
      body:{
        run_id:runId,
        market_key:context.marketKey,
        location_value:context.locationValue,
        mode:conf.mode,
        job_id:conf.job_id||null,
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
      context.marketName+' completed: '+stored.success+'/'+stored.total+' operationally successful; '+
      (stored.states?Object.entries(stored.states).map(([k,v])=>k+' '+v).join(', '):'states recorded')+'.',
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
    if(heartbeatTimer)clearInterval(heartbeatTimer);
    running=false;
    await closePreviousRankWindow().catch(()=>{});
    if(previousActive?.id){
      await chrome.tabs.update(previousActive.id,{active:true}).catch(()=>{});
    }
  }
}


let runnerPollTimer=null;

async function runnerTick(force=false){
  try{
    const me=await chrome.tabs.getCurrent();
    const {runnerLeaderTabId}=await chrome.storage.local.get('runnerLeaderTabId');
    if(!me?.id || Number(runnerLeaderTabId)!==Number(me.id)){
      return {ok:true,standby:true};
    }
    return await runCheck(force);
  }catch(e){
    const msg=e?.message||String(e);
    await setStatus('Runner error: '+msg,{lastError:msg});
    return {ok:false,error:msg};
  }
}

async function bootRunner(){
  await setStatus('Persistent agent ready — waiting for work.',{
    runnerStartedAt:new Date().toISOString(),
    runnerMode:'persistent-tab'
  });
  await runnerTick(false);
  if(runnerPollTimer)clearInterval(runnerPollTimer);
  runnerPollTimer=setInterval(()=>runnerTick(false),15000);
}

chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&changes.runnerKick){
    runnerTick(true).catch(()=>{});
  }
});

window.addEventListener('beforeunload',()=>{
  if(runnerPollTimer)clearInterval(runnerPollTimer);
});

bootRunner().catch(async e=>{
  const msg=e?.message||String(e);
  await setStatus('Runner boot failed: '+msg,{lastError:msg});
});
