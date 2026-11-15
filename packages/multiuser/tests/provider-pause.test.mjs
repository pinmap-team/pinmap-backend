import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AppError} from '../lib/errors.mjs';
import {openDatabase} from '../service/db.mjs';
import {claimJob,pausedProviders,resumeProvider} from '../service/jobs.mjs';
import {processJob,runWorker} from '../service/worker.mjs';

function addJob(db,{id,user=id,provider='gemini',collectPublic=false,created=0}){
  const date=new Date(Date.UTC(2026,0,1,0,0,created)).toISOString();
  db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(user,`${user}@example.test`,'test',date);
  db.prepare('INSERT INTO posts(id,user_id,source_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,user,`https://www.instagram.com/p/${id}/`,'test',date,date);
  db.prepare(`INSERT INTO jobs(id,user_id,post_id,fingerprint,status,source_url,material_json,settings_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,user,id,`fingerprint-${id}`,'queued',`https://www.instagram.com/p/${id}/`,JSON.stringify({caption:'',assets:[],...(collectPublic?{collect_public:true}:{})}),JSON.stringify({providerName:provider,model:'test'}),date,date);
}

const prepared=()=>({images:[],audio:[],evidence:[],coverage:{kind:'caption_only'}});

test('a provider quota error pauses only its queued paid-media jobs across workers and restart',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-provider-pause-'));
  const file=path.join(folder,'jobs.sqlite'),first=openDatabase(file),second=openDatabase(file);
  try{
    addJob(first,{id:'gemini-first',created:1});
    addJob(first,{id:'gemini-next',created:2});
    addJob(first,{id:'vllm-next',provider:'vllm',created:3});
    addJob(first,{id:'public-link',collectPublic:true,created:4});
    const claimed=claimJob(first,'worker-one');
    assert.equal(claimed.id,'gemini-first');
    let calls=0;
    await processJob(first,claimed,{dataDir:folder,prepare:prepared,provider:{async summarize(){calls++;throw new AppError('한도 초과',{code:'provider_rate_limited',status:429});}}});
    assert.equal(calls,1);
    assert.equal(first.prepare('SELECT status FROM jobs WHERE id=?').get('gemini-first').status,'failed');
    assert.deepEqual(pausedProviders(second).map(x=>[x.provider_name,x.status]),[['gemini',429]]);
    assert.equal(second.prepare('SELECT status FROM jobs WHERE id=?').get('gemini-next').status,'queued');
    assert.equal(claimJob(second,'worker-two').id,'vllm-next');
    assert.equal(claimJob(second,'worker-three').id,'public-link');
    assert.equal(claimJob(second,'worker-four'),null);

    first.close();second.close();
    const restarted=openDatabase(file);
    try{
      assert.equal(pausedProviders(restarted)[0].provider_name,'gemini');
      assert.equal(claimJob(restarted,'worker-five'),null);
      assert.equal(resumeProvider(restarted,'gemini'),1);
      assert.equal(claimJob(restarted,'worker-six').id,'gemini-next');
    }finally{restarted.close();}
  }finally{
    if(first.open)first.close();if(second.open)second.close();
    await fs.rm(folder,{recursive:true,force:true});
  }
});

test('an ASR quota error pauses all paid-media providers but leaves public-link collection eligible',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-asr-pause-'));
  const db=openDatabase(path.join(folder,'jobs.sqlite'));
  try{
    addJob(db,{id:'audio-first',created:1});
    addJob(db,{id:'vllm-next',provider:'vllm',created:2});
    addJob(db,{id:'public-link',collectPublic:true,created:3});
    const job=claimJob(db,'audio-worker');
    await processJob(db,job,{dataDir:folder,prepare:()=>({images:[],audio:[{id:'audio',mime:'audio/wav',path:'unused'}],evidence:[],coverage:{kind:'uploaded_video'}}),transcriber:{async transcribe(){throw new AppError('ASR 한도 초과',{code:'asr_error',status:429});}},provider:{async summarize(){throw new Error('must not summarize');}}});
    assert.deepEqual(pausedProviders(db).map(x=>x.provider_name),['all_media']);
    assert.equal(claimJob(db,'other-worker').id,'public-link');
    assert.equal(claimJob(db,'third-worker'),null);
  }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});

test('public-link authentication errors do not pause paid-media providers',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-public-pause-'));
  const db=openDatabase(path.join(folder,'jobs.sqlite'));
  try{
    addJob(db,{id:'public-first',collectPublic:true,created:1});
    addJob(db,{id:'media-next',created:2});
    const job=claimJob(db,'public-worker');
    await processJob(db,job,{dataDir:folder,desktopCollector:async()=>{throw new AppError('인증 실패',{code:'extractor_auth',status:401});}});
    assert.deepEqual(pausedProviders(db),[]);
    assert.equal(claimJob(db,'media-worker').id,'media-next');
  }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});

for(const status of [401,403]){
  test(`provider HTTP ${status} pauses queued jobs until explicitly resumed`,async()=>{
    const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-provider-auth-'));
    const db=openDatabase(path.join(folder,'jobs.sqlite'));
    try{
      addJob(db,{id:'auth-first',created:1});
      addJob(db,{id:'auth-next',created:2});
      await processJob(db,claimJob(db,'auth-worker'),{dataDir:folder,prepare:prepared,provider:{async summarize(){throw new AppError('인증 실패',{code:'provider_auth_error',status});}}});
      assert.deepEqual(pausedProviders(db).map(x=>[x.provider_name,x.status]),[['gemini',status]]);
      assert.equal(claimJob(db,'another-worker'),null);
      assert.equal(resumeProvider(db,'gemini'),1);
      assert.equal(claimJob(db,'another-worker').id,'auth-next');
    }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
  });
}

test('a broken provider configuration fails one job and pauses the rest',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-provider-config-'));
  const db=openDatabase(path.join(folder,'jobs.sqlite'));
  try{
    addJob(db,{id:'config-first',created:1});
    addJob(db,{id:'config-next',created:2});
    const controller=new AbortController();
    let attempts=0;
    await runWorker({db,dataDir:folder,pollMs:0,signal:controller.signal,providerFactory:()=>{
      attempts++;controller.abort();throw new Error('missing provider configuration');
    }});
    assert.equal(attempts,1);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get('config-first').status,'failed');
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get('config-next').status,'queued');
    assert.deepEqual(pausedProviders(db).map(x=>[x.provider_name,x.status,x.code]),[['gemini',503,'provider_config']]);
  }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});
