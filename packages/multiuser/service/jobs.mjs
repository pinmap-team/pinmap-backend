import {seedExportAddresses} from './export-addresses.mjs';
import crypto from 'node:crypto';
import {snapshotInput} from '../lib/catalog.mjs';
import {PROMPT_VERSION} from '../lib/contract.mjs';
import {AppError} from '../lib/errors.mjs';
import {now,parseJson,publicJob} from './db.mjs';

export function getPost(db,userId,postId){return db.prepare('SELECT * FROM posts WHERE id=? AND user_id=?').get(postId,userId);}
export function postAssets(db,userId,postId){return db.prepare('SELECT * FROM assets WHERE user_id=? AND post_id=? ORDER BY created_at,id').all(userId,postId).map(x=>({...x,complete:!!x.complete}));}
export function jobForUser(db,userId,jobId){const job=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(jobId,userId);if(!job)throw new AppError('작업을 찾지 못했습니다.',{status:404});return publicJob(job);}
export async function enqueueJob(db,userId,postId,settings,{force=false,requireVisual=false,collectPublic=false,env=process.env}={}){
  const post=getPost(db,userId,postId);if(!post)throw new AppError('게시물을 찾지 못했습니다.',{status:404});
  const assets=postAssets(db,userId,postId);
  if(collectPublic&&!env.PINMAP_EXTRACTOR_ORIGIN)throw new AppError('링크 분석 서버가 설정되지 않았습니다. 사진·영상을 업로드하거나 캡션만 분석하세요.',{code:'collection_provider',status:400});
  if(requireVisual&&!collectPublic&&!assets.some(a=>['image','video'].includes(a.kind)))throw new AppError('사진이나 영상이 없는 게시물입니다.',{code:'missing_visual',status:400});
  const materialPost={id:post.id,url:post.source_url,caption:post.caption,assets};
  const providerName=settings.providerName;
  const {material,fingerprint}=collectPublic?{material:{caption:post.caption,assets:[],collect_public:true},fingerprint:crypto.createHash('sha256').update(JSON.stringify({url:post.source_url,settings,promptVersion:PROMPT_VERSION,collect_public:true})).digest('hex')}:await snapshotInput(materialPost,{...settings,promptVersion:PROMPT_VERSION});
  const existing=db.prepare(`SELECT * FROM jobs WHERE user_id=? AND post_id=? AND fingerprint=? AND status IN ('queued','preparing','summarizing','completed') ORDER BY created_at DESC LIMIT 1`).get(userId,postId,fingerprint);
  if(existing&&(!force||existing.status!=='completed'))return{job:publicJob(existing),reused:true};
  const active=db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND status IN ('queued','preparing','summarizing')").get(userId).n;
  if(active>=25)throw new AppError('계정당 대기·진행 작업은 25건까지입니다.',{code:'queue_quota',status:429});
  const id=crypto.randomUUID(),date=now();
  db.prepare(`INSERT INTO jobs(id,user_id,post_id,fingerprint,status,source_url,material_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,userId,postId,fingerprint,'queued',post.source_url,JSON.stringify(material),JSON.stringify({providerName,model:settings.model,maxImages:settings.maxImages,maxOutputTokens:settings.maxOutputTokens,maxVideoSeconds:settings.maxVideoSeconds,promptVersion:PROMPT_VERSION}),date,date);
  return{job:jobForUser(db,userId,id),reused:false};
}
export function claimJob(db,workerId,leaseMs=20*60*1000){
  return db.transaction(()=>{
    const row=db.prepare(`SELECT j.* FROM jobs j WHERE j.status='queued'
      AND (json_extract(j.material_json,'$.collect_public') = 1 OR NOT EXISTS (
        SELECT 1 FROM provider_pauses pause WHERE pause.provider_name='all_media'
          OR pause.provider_name=json_extract(j.settings_json,'$.providerName')
      ))
      AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.user_id=j.user_id AND active.status IN ('preparing','summarizing'))
      ORDER BY (SELECT COUNT(*) FROM jobs done WHERE done.user_id=j.user_id AND done.status='completed' AND done.completed_at>?) ASC,j.created_at ASC LIMIT 1`).get(new Date(Date.now()-86400000).toISOString());
    if(!row)return null;
    db.prepare("UPDATE jobs SET status='preparing',worker_id=?,lease_until=?,updated_at=? WHERE id=? AND status='queued'").run(workerId,Date.now()+leaseMs,now(),row.id);
    return db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id);
  }).immediate();
}
export function pauseProvider(db,providerName,{status,code}){
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(providerName||'')||!([401,403,429].includes(status)||(status===503&&code==='provider_config')))throw new Error('Invalid provider pause');
  db.prepare(`INSERT INTO provider_pauses(provider_name,status,code,paused_at) VALUES(?,?,?,?)
    ON CONFLICT(provider_name) DO UPDATE SET status=excluded.status,code=excluded.code,paused_at=excluded.paused_at`)
    .run(providerName,status,String(code||'provider_error').slice(0,80),now());
}
export function resumeProvider(db,providerName){
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(providerName||''))throw new Error('Invalid provider name');
  return db.prepare('DELETE FROM provider_pauses WHERE provider_name=?').run(providerName).changes;
}
export function pausedProviders(db){return db.prepare('SELECT provider_name,status,code,paused_at FROM provider_pauses ORDER BY provider_name').all();}
export function markExpiredJobs(db){
  const date=now();return db.prepare("UPDATE jobs SET status='needs_review',error_json=?,worker_id=NULL,lease_until=NULL,updated_at=? WHERE status IN ('preparing','summarizing') AND lease_until<?").run(JSON.stringify({code:'worker_lost',message:'작업자가 중단됐습니다. 중복 AI 호출을 막기 위해 자동 재시도하지 않았습니다.'}),date,Date.now()).changes;
}
export function updateJob(db,id,workerId,patch){
  const current=db.prepare('SELECT * FROM jobs WHERE id=? AND worker_id=?').get(id,workerId);if(!current)return false;
  const fields=Object.keys(patch);if(!fields.length)return true;
  db.prepare(`UPDATE jobs SET ${fields.map(f=>`${f}=?`).join(',')},updated_at=? WHERE id=? AND worker_id=?`).run(...fields.map(f=>patch[f]),now(),id,workerId);return true;
}
export function cancelJob(db,userId,id){const row=db.prepare('SELECT status FROM jobs WHERE id=? AND user_id=?').get(id,userId);if(!row)throw new AppError('작업을 찾지 못했습니다.',{status:404});if(row.status!=='queued')throw new AppError('대기 중인 작업만 취소할 수 있습니다.',{status:409});db.prepare("UPDATE jobs SET status='cancelled',updated_at=? WHERE id=? AND user_id=?").run(now(),id,userId);}
export function materialFromJob(job){return parseJson(job.material_json);}

// A ZIP import is one explicit batch request. With the shared extractor,
// every URL can be queued; otherwise only posts with a caption are queued.
export function enqueueImportedPosts(db,userId,urls,settings,env=process.env){
 return db.transaction(()=>{
  let queued=0,reused=0,skipped=0;
  for(const url of urls){
   const post=db.prepare('SELECT * FROM posts WHERE user_id=? AND source_url=?').get(userId,url);
   if(!post)throw new Error('Imported post missing');
   if(db.prepare('SELECT id FROM jobs WHERE user_id=? AND post_id=? LIMIT 1').get(userId,post.id)){reused++;continue;}
   const collectPublic=!!env.PINMAP_EXTRACTOR_ORIGIN;
   if(!collectPublic&&!post.caption?.trim()){skipped++;continue;}
   const date=now(),fingerprint=crypto.createHash('sha256').update(JSON.stringify({url:post.source_url,settings,promptVersion:PROMPT_VERSION,collect_public:collectPublic})).digest('hex');
   const config={...settings,promptVersion:PROMPT_VERSION};
   db.prepare('INSERT INTO jobs(id,user_id,post_id,fingerprint,status,source_url,material_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),userId,post.id,fingerprint,'queued',url,JSON.stringify({caption:post.caption,assets:[],...(collectPublic?{collect_public:true}:{})}),JSON.stringify(config),date,date);queued++;
  }
  seedExportAddresses(db,userId);return{queued,reused,skipped};
 }).immediate();
}
