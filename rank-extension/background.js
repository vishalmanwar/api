const RUNNER_FILE='runner.html';
const RUNNER_VERSION='2026.09.29.60-stable-session-v1';
const WATCHDOG_ALARM='zipify-runner-watchdog';

async function ensureRunner(){
  const baseUrl=chrome.runtime.getURL(RUNNER_FILE);
  const runnerUrl=baseUrl+'?v='+encodeURIComponent(RUNNER_VERSION);
  const base=new URL(baseUrl);

  const tabs=await chrome.tabs.query({});
  const runners=tabs.filter(t=>{
    try{
      const u=new URL(String(t.url||''));
      return u.origin===base.origin && u.pathname===base.pathname;
    }catch{return false}
  });

  let tab=runners.find(t=>String(t.url||'')===runnerUrl)||null;

  if(!tab){
    tab=await chrome.tabs.create({url:runnerUrl,active:true,pinned:true});
  }
  if(!tab?.id)throw new Error('Could not establish Zipify runner tab.');

  await chrome.storage.local.set({
    runnerLeaderTabId:tab.id,
    runnerLeaderSetAt:new Date().toISOString(),
    runnerLeaderVersion:RUNNER_VERSION
  });

  for(const extra of runners){
    if(extra.id && extra.id!==tab.id){
      await chrome.tabs.remove(extra.id).catch(()=>{});
    }
  }

  await chrome.tabs.update(tab.id,{pinned:true,autoDiscardable:false}).catch(()=>{});
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
    boot().then(()=>sendResponse({ok:true,version:'2026.09.29.60-stable-session-v1'}))
      .catch(e=>sendResponse({ok:false,error:e?.message||String(e)}));
    return true;
  }
});