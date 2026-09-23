import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const cfgText=fs.readFileSync(path.join(here,'agent-config.json'),'utf8').replace(/^\uFEFF/,'').trim();
const cfg=JSON.parse(cfgText);
const API=cfg.api;
const TOKEN=cfg.token;

async function api(action,opts={}){
  const r=await fetch(API+'?action='+encodeURIComponent(action),{
    ...opts,
    headers:{'Content-Type':'application/json','X-Rank-Agent':TOKEN,...(opts.headers||{})}
  });
  const t=await r.text(); let d={}; try{d=JSON.parse(t)}catch{}
  if(!r.ok) throw new Error(d.error||('HTTP '+r.status+' '+t));
  return d;
}
async function currentLocation(page){
  const a=await page.locator('#glow-ingress-line1').first().textContent().catch(()=>'');
  const b=await page.locator('#glow-ingress-line2').first().textContent().catch(()=>'');
  return ((a||'')+' '+(b||'')).replace(/\s+/g,' ').trim();
}
async function loadSearch(page,keyword,pageNum=1){
  const base='https://www.amazon.in/s?k='+encodeURIComponent(keyword);
  const url=pageNum>1?base+'&page='+pageNum:base;
  let last='';
  for(let a=1;a<=4;a++){
    try{
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
      await page.waitForTimeout(1800+a*700);
      last=await page.title().catch(()=>'');
      const body=await page.locator('body').innerText().catch(()=>'');
      const cards=await page.locator('[data-component-type="s-search-result"][data-asin]').count();
      if(body.trim().length>200 && cards>0 && !/503 - Service Unavailable|Robot Check|Enter the characters/i.test(body)) return;
    }catch{}
    await page.waitForTimeout(800*a);
  }
  const finalUrl=page.url();
  const body=await page.locator('body').innerText().catch(()=>'');
  const shot=path.join(here,'amazon-failure-'+Date.now()+'.png');
  await page.screenshot({path:shot,fullPage:false}).catch(()=>{});
  throw new Error('Amazon search unavailable. Title: '+last+' URL: '+finalUrl+' bodyChars: '+body.length+' screenshot: '+shot);
}
async function setPincode(page,keyword,pincode){
  await loadSearch(page,keyword,1);
  const r=await page.evaluate(async zip=>{
    const body=new URLSearchParams({locationType:'LOCATION_INPUT',zipCode:zip,storeContext:'generic',deviceType:'web',pageType:'Search',actionSource:'glow'});
    const res=await fetch('/gp/delivery/ajax/address-change.html',{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','X-Requested-With':'XMLHttpRequest'},
      body:body.toString()
    });
    const text=await res.text(); let json=null; try{json=JSON.parse(text)}catch{}
    return {ok:res.ok,status:res.status,text:text.slice(0,800),json};
  },pincode);
  const accepted=String(r?.json?.address?.zipCode||'')===pincode && (r?.json?.sembuUpdated===1||r?.json?.sembuUpdated===true);
  if(!r.ok||!accepted) throw new Error('Amazon rejected pincode '+pincode);
  await page.reload({waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(1800);
  const loc=await currentLocation(page);
  if(!loc.includes(pincode)) throw new Error('Amazon did not confirm pincode '+pincode+'. Header: '+loc);
  return loc;
}
async function scrape(page,keyword,rules,pincode,mode){
  const start=Date.now(); let organic=0,sponsored=0,absolute=0,sponsoredSeen=0;
  const found=new Map();
  for(let pg=1;pg<=3;pg++){
    await loadSearch(page,keyword,pg);
    const loc=await currentLocation(page);
    if(!loc.includes(pincode)) throw new Error('Amazon location changed. Expected '+pincode+', got '+loc);
    const cards=await page.locator('[data-component-type="s-search-result"][data-asin]').evaluateAll(els=>
      els.map(el=>{
        const asin=(el.getAttribute('data-asin')||'').trim().toUpperCase();
        const text=(el.textContent||'').replace(/\s+/g,' ').trim();
        const sponsored=/\bSponsored\b/i.test(text) || !!el.querySelector('[aria-label*="Sponsored"], [data-component-type="sp-sponsored-result"]');
        return {asin,sponsored};
      }).filter(x=>x.asin)
    );
    for(const card of cards){
      absolute++;
      if(card.sponsored){sponsored++;sponsoredSeen++;} else organic++;
      const target=rules.find(r=>r.asin.toUpperCase()===card.asin);
      if(!target) continue;
      const cur=found.get(card.asin)||{};
      if(card.sponsored && cur.sponsored_position==null){
        cur.sponsored_found=true;cur.sponsored_position=sponsored;cur.sponsored_page=pg;cur.sponsored_absolute_position=absolute;
      }
      if(!card.sponsored && cur.organic_rank==null){
        cur.organic_rank=organic;cur.organic_page=pg;cur.organic_absolute_position=absolute;cur.total_sponsored_ads_before_organic=sponsoredSeen;
      }
      found.set(card.asin,cur);
    }
    if(mode==='full' && rules.every(r=>found.get(r.asin.toUpperCase())?.organic_rank!=null)) break;
  }
  return rules.map(r=>{
    const f=found.get(r.asin.toUpperCase())||{};
    return {
      rule_id:r.rule_id,asin:r.asin,keyword:r.keyword,pincode,device:r.device,
      checked_at:new Date().toISOString(),status:'SUCCESS',
      organic_rank:f.organic_rank??null,organic_page:f.organic_page??null,organic_absolute_position:f.organic_absolute_position??null,
      sponsored_found:!!f.sponsored_found,sponsored_position:f.sponsored_position??null,sponsored_page:f.sponsored_page??null,
      sponsored_absolute_position:f.sponsored_absolute_position??null,total_sponsored_ads_before_organic:f.total_sponsored_ads_before_organic??null,
      total_results_scanned:absolute,response_time_ms:Date.now()-start
    };
  });
}
async function main(){
  const conf=await api('local_worker_config');
  if(conf.mode==='skip'){ console.log('No rank check due.'); return; }
  console.log('Rank check mode:',conf.mode,'Rules:',conf.rules.length);
  const results=[];
  const groups=new Map();
  for(const r of conf.rules){const key=r.pincode+'|'+r.device;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
  for(const [key,rules] of groups){
      const [pincode,device]=key.split('|');
      const safeKey=(pincode+'-'+device).replace(/[^a-zA-Z0-9_-]/g,'_');
      const profileDir=path.join(here,'chrome-profile-'+safeKey);
      const launchOptions={
        headless:false,
        locale:'en-IN',
        timezoneId:'Asia/Kolkata',
        viewport:device==='mobile'?{width:412,height:915}:{width:1440,height:1000},
        args:[
          '--disable-blink-features=AutomationControlled',
          '--window-position=-32000,-32000',
          '--window-size=1440,1000',
          '--no-first-run',
          '--no-default-browser-check'
        ],
        ignoreDefaultArgs:['--enable-automation']
      };
      let context;
      try{
        context=await chromium.launchPersistentContext(profileDir,{...launchOptions,channel:'chrome'});
        console.log('Using installed Google Chrome.');
      }catch(e){
        console.log('Installed Chrome launch failed, falling back to Playwright Chromium:',e?.message||String(e));
        context=await chromium.launchPersistentContext(profileDir,launchOptions);
      }
      await context.addInitScript(()=>{
        try{Object.defineProperty(navigator,'webdriver',{get:()=>undefined});}catch{}
      });
      const page=context.pages()[0]||await context.newPage();
      try{
        console.log('Verified location:',await setPincode(page,rules[0].keyword,pincode));
        const byKeyword=new Map();
        for(const r of rules){if(!byKeyword.has(r.keyword))byKeyword.set(r.keyword,[]);byKeyword.get(r.keyword).push(r);}
        for(const [kw,rr] of byKeyword){
          try{const got=await scrape(page,kw,rr,pincode,conf.mode);results.push(...got);console.log(kw,got.map(x=>({asin:x.asin,organic:x.organic_rank,sponsored:x.sponsored_position})));}
          catch(e){results.push(...rr.map(r=>({rule_id:r.rule_id,asin:r.asin,keyword:r.keyword,pincode,device:r.device,checked_at:new Date().toISOString(),status:'FAILED',error:e?.message||String(e)})));}
        }
      }catch(e){
        results.push(...rules.map(r=>({rule_id:r.rule_id,asin:r.asin,keyword:r.keyword,pincode,device:r.device,checked_at:new Date().toISOString(),status:'FAILED',error:e?.message||String(e)})));
      }finally{await context.close();}
    }
  const runId='local-'+os.hostname()+'-'+Date.now();
  console.log('Uploaded:',await api('local_worker_ingest',{method:'POST',body:JSON.stringify({run_id:runId,mode:conf.mode,request_id:conf.request_id||null,results})}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
