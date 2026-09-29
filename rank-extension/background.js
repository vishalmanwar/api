const RUNNER_FILE='runner.html';
const WATCHDOG_ALARM='zipify-runner-watchdog';

async function ensureRunner(){
  const runnerUrl=chrome.runtime.getURL(RUNNER_FILE);
  const tabs=await chrome.tabs.query({});
  const runners=tabs.filter(t=>String(t.url||'').split('#')[0]===runnerUrl);

  let tab=runners[0]||null;
  for(const extra of runners.slice(1)){
    if(extra.id)await chrome.tabs.remove(extra.id).catch(()=>{});
  }

  if(!tab){
    tab=await chrome.tabs.create({url:runnerUrl,active:false,pinned:true});
  }

  if(tab?.id){
    await chrome.tabs.update(tab.id,{pinned:true,autoDiscardable:false}).catch(()=>{});
  }
  return tab;
}

async function boot(){
  await ensureRunner();
  const alarm=await chrome.alarms.get(WATCHDOG_ALARM);
  if(!alarm){
    await chrome.alarms.create(WATCHDOG_ALARM,{delayInMinutes:0.1,periodInMinutes:1});
  }
}

boot().catch(()=>{});
chrome.runtime.onInstalled.addListener(()=>boot().catch(()=>{}));
chrome.runtime.onStartup.addListener(()=>boot().catch(()=>{}));
chrome.alarms.onAlarm.addListener(a=>{
  if(a.name===WATCHDOG_ALARM)ensureRunner().catch(()=>{});
});

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg?.type==='runNow'){
    (async()=>{
      await ensureRunner();
      await chrome.storage.local.set({runnerKick:Date.now()});
      sendResponse({ok:true});
    })().catch(e=>sendResponse({ok:false,error:e?.message||String(e)}));
    return true;
  }
  if(msg?.type==='ensureAlarm'){
    boot().then(()=>sendResponse({ok:true,version:'2026.09.29.57-runner-v1'}))
      .catch(e=>sendResponse({ok:false,error:e?.message||String(e)}));
    return true;
  }
});