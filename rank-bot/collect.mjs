import fs from 'node:fs';
import path from 'node:path';

const root=process.env.ARTIFACT_DIR||'rank-artifacts';
const api=process.env.RANK_API;
const token=process.env.WORKER_TOKEN;
const runId=String(process.env.GITHUB_RUN_ID||'');

function walk(dir){
  if(!fs.existsSync(dir)) return [];
  const out=[];
  for(const ent of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,ent.name);
    if(ent.isDirectory()) out.push(...walk(p));
    else if(ent.isFile() && ent.name==='rank-results.json') out.push(p);
  }
  return out;
}

const files=walk(root);
const attempts=[];
for(const file of files){
  try{attempts.push(JSON.parse(fs.readFileSync(file,'utf8')))}catch{}
}

const byRule=new Map();
for(const a of attempts){
  for(const r of a.results||[]){
    if(!byRule.has(r.rule_id)) byRule.set(r.rule_id,[]);
    byRule.get(r.rule_id).push({...r,_attempt:Number(a.attempt||99)});
  }
}

const merged=[];
for(const [ruleId,candidates] of byRule){
  candidates.sort((a,b)=>a._attempt-b._attempt);
  const success=candidates.find(x=>x.status==='SUCCESS');
  const pick=success||candidates[0];
  if(pick){delete pick._attempt;merged.push(pick);}
}

const mode=attempts[0]?.mode || process.env.RANK_MODE || 'full';
const requestId=attempts[0]?.request_id ?? (process.env.REQUEST_ID?Number(process.env.REQUEST_ID):null);

const body={
  run_id:runId,
  attempt:0,
  mode,
  request_id:requestId,
  results:merged
};

const r=await fetch(api+'?action=worker_ingest',{
  method:'POST',
  headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
  body:JSON.stringify(body)
});
const text=await r.text();
console.log('INGEST_RESPONSE',r.status,text);
if(!r.ok) console.log('Ingest did not succeed, but workflow will not fail to avoid email noise.');
