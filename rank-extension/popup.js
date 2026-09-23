const $=id=>document.getElementById(id);
async function refresh(){
  const d=await chrome.storage.local.get(['token','status','updatedAt','lastSuccess','lastFailed']);
  $('token').value=d.token||'';
  $('status').textContent=d.status||'Not configured.';
}
$('save').onclick=async()=>{
  const token=$('token').value.trim();
  if(!token){$('status').textContent='Token is required.';return;}
  await chrome.storage.local.set({token,status:'Token saved.'});
  await chrome.runtime.sendMessage({type:'ensureAlarm'});
  refresh();
};
$('run').onclick=async()=>{
  const token=$('token').value.trim();
  if(token) await chrome.storage.local.set({token});
  $('status').textContent='Starting…';
  await chrome.runtime.sendMessage({type:'runNow'});
  setTimeout(refresh,1200);
};
chrome.storage.onChanged.addListener(()=>refresh());
refresh();