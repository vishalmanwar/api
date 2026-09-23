import { chromium } from 'playwright';
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync('rank-config.json','utf8'));
const attempt = Number(process.env.WORKER_ATTEMPT || 1);
const runId = String(process.env.GITHUB_RUN_ID || '');
const mode = String(config.mode || 'full');
const maxPages = 3;
const checkedAt = new Date().toISOString();
const results = [];

function failResult(rule, error) {
  return {
    rule_id: rule.rule_id,
    asin: rule.asin,
    keyword: rule.keyword,
    pincode: rule.pincode,
    device: rule.device,
    checked_at: new Date().toISOString(),
    status: 'FAILED',
    error: String(error || 'Amazon check failed'),
    provider: 'github-playwright',
    worker_attempt: attempt
  };
}

async function currentLocation(page) {
  const one = await page.locator('#glow-ingress-line1').first().textContent().catch(()=>'');
  const two = await page.locator('#glow-ingress-line2').first().textContent().catch(()=>'');
  return ((one||'')+' '+(two||'')).replace(/\s+/g,' ').trim();
}

async function loadSearch(page, keyword, pageNum=1, attempts=4) {
  const base = 'https://www.amazon.in/s?k=' + encodeURIComponent(keyword);
  const url = pageNum > 1 ? base + '&page=' + pageNum : base;
  let lastTitle = '';
  for (let a=1;a<=attempts;a++) {
    try {
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
      await page.waitForTimeout(2200 + a*800);
      lastTitle = await page.title().catch(()=>'');
      const body = await page.locator('body').innerText().catch(()=>'');
      const cards = await page.locator('[data-component-type="s-search-result"][data-asin]').count();
      if (!/503 - Service Unavailable|Robot Check|Enter the characters you see below/i.test(body) &&
          body.trim().length > 200 && cards > 0) {
        return {url:page.url(),title:lastTitle,cards};
      }
    } catch {}
    await page.waitForTimeout(1200*a);
  }
  throw new Error('Amazon search page unavailable after retries. Last title: '+lastTitle);
}

async function setPincode(page, keyword, pincode) {
  await loadSearch(page,keyword,1,4);

  const response = await page.evaluate(async (zip) => {
    const body = new URLSearchParams({
      locationType:'LOCATION_INPUT',
      zipCode:zip,
      storeContext:'generic',
      deviceType:'web',
      pageType:'Search',
      actionSource:'glow'
    });
    const r = await fetch('/gp/delivery/ajax/address-change.html',{
      method:'POST',
      credentials:'include',
      headers:{
        'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Requested-With':'XMLHttpRequest'
      },
      body:body.toString()
    });
    const text = await r.text();
    let json=null; try{json=JSON.parse(text)}catch{}
    return {ok:r.ok,status:r.status,text:text.slice(0,1000),json};
  },pincode);

  const acceptedZip = String(response?.json?.address?.zipCode || '');
  const accepted = response?.ok &&
    (response?.json?.sembuUpdated===1 || response?.json?.sembuUpdated===true) &&
    acceptedZip===pincode;

  if(!accepted) throw new Error('Amazon rejected pincode '+pincode+': HTTP '+response.status+' '+response.text);

  await page.reload({waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(2200);
  const loc = await currentLocation(page);
  if(!loc.includes(pincode)) throw new Error('Pincode response accepted but Amazon header did not confirm '+pincode+'. Header: '+loc);
  return loc;
}

async function scrapeKeyword(page, keyword, rules, pincode) {
  const started=Date.now();
  const targets = new Map(rules.map(r=>[String(r.asin).toUpperCase(),r]));
  const found = new Map();
  let organicCounter=0;
  let sponsoredCounter=0;
  let absoluteCounter=0;
  let sponsoredSeen=0;

  for(let pageNum=1;pageNum<=maxPages;pageNum++){
    await loadSearch(page,keyword,pageNum,4);
    const loc=await currentLocation(page);
    if(!loc.includes(pincode)) throw new Error('Amazon location changed during scan. Expected '+pincode+', got '+loc);

    const cards = await page.locator('[data-component-type="s-search-result"][data-asin]').evaluateAll((els)=>
      els.map(el=>{
        const asin=(el.getAttribute('data-asin')||'').trim().toUpperCase();
        const text=(el.textContent||'').replace(/\s+/g,' ').trim();
        const sponsored =
          !!el.querySelector('[aria-label*="Sponsored"], [data-component-type="sp-sponsored-result"], .puis-label-popover-default') ||
          /(^|\s)Sponsored(\s|$)/i.test(text);
        return {asin,sponsored};
      }).filter(x=>x.asin)
    );

    for(const card of cards){
      absoluteCounter++;
      if(card.sponsored){sponsoredCounter++;sponsoredSeen++;}
      else organicCounter++;

      if(!targets.has(card.asin)) continue;
      const cur=found.get(card.asin)||{
        organic_rank:null,organic_page:null,organic_absolute_position:null,
        sponsored_found:false,sponsored_position:null,sponsored_page:null,sponsored_absolute_position:null,
        total_sponsored_ads_before_organic:null
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

    // Stop early only when every target has an organic hit and we've scanned at least page 1.
    const allOrganic=[...targets.keys()].every(a=>found.get(a)?.organic_rank!=null);
    if(allOrganic && pageNum>=1) break;
  }

  return rules.map(rule=>{
    const f=found.get(String(rule.asin).toUpperCase())||{};
    return {
      rule_id:rule.rule_id,
      asin:rule.asin,
      keyword:rule.keyword,
      pincode,
      device:rule.device,
      checked_at:checkedAt,
      status:'SUCCESS',
      organic_rank:f.organic_rank??null,
      organic_page:f.organic_page??null,
      organic_absolute_position:f.organic_absolute_position??null,
      sponsored_found:!!f.sponsored_found,
      sponsored_position:f.sponsored_position??null,
      sponsored_page:f.sponsored_page??null,
      sponsored_absolute_position:f.sponsored_absolute_position??null,
      total_sponsored_ads_before_organic:f.total_sponsored_ads_before_organic??null,
      total_results_scanned:absoluteCounter,
      response_time_ms:Date.now()-started,
      snapshot_ref:runId+':'+attempt+':'+pincode+':'+keyword
    };
  });
}

const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
try{
  const byContext=new Map();
  for(const rule of config.rules||[]){
    const key=String(rule.pincode)+'|'+String(rule.device||'desktop');
    if(!byContext.has(key)) byContext.set(key,[]);
    byContext.get(key).push(rule);
  }

  for(const [key,rules] of byContext){
    const [pincode,device]=key.split('|');
    const context=await browser.newContext({
      locale:'en-IN',
      timezoneId:'Asia/Kolkata',
      viewport:device==='mobile'?{width:412,height:915}:{width:1440,height:1000},
      isMobile:device==='mobile',
      hasTouch:device==='mobile',
      userAgent:device==='mobile'
        ? 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
    });
    const page=await context.newPage();

    try{
      const firstKeyword=rules[0]?.keyword || 'zip lock bag';
      const loc=await setPincode(page,firstKeyword,pincode);
      console.log('Verified Amazon location:',loc);

      const byKeyword=new Map();
      for(const rule of rules){
        if(!byKeyword.has(rule.keyword)) byKeyword.set(rule.keyword,[]);
        byKeyword.get(rule.keyword).push(rule);
      }

      for(const [keyword,keywordRules] of byKeyword){
        try{
          const rr=await scrapeKeyword(page,keyword,keywordRules,pincode);
          results.push(...rr);
          console.log('Checked',keyword,JSON.stringify(rr.map(x=>({asin:x.asin,organic:x.organic_rank,sponsored:x.sponsored_position}))));
        }catch(e){
          console.error('Keyword failed',keyword,e?.message||String(e));
          results.push(...keywordRules.map(r=>failResult(r,e?.message||String(e))));
        }
      }
    }catch(e){
      console.error('Context failed',pincode,device,e?.message||String(e));
      results.push(...rules.map(r=>failResult(r,e?.message||String(e))));
    }finally{
      await context.close();
    }
  }
}finally{
  await browser.close();
}

const output={
  run_id:runId,
  attempt,
  mode,
  request_id:config.request_id||null,
  generated_at:new Date().toISOString(),
  results
};
fs.writeFileSync('rank-results.json',JSON.stringify(output,null,2));
console.log('RANK_WORKER_SUMMARY='+JSON.stringify({
  run_id:runId,attempt,mode,total:results.length,
  success:results.filter(x=>x.status==='SUCCESS').length,
  failed:results.filter(x=>x.status==='FAILED').length
}));
// Amazon blocking is a data-quality failure, not a CI failure. Always exit 0.
