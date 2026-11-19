import {explicitCaptionAddresses} from '../lib/address.mjs';
import {readImageText} from '../lib/ocr.mjs';
import {extractMediaAddresses} from '../lib/media-addresses.mjs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareMedia} from '../lib/media.mjs';
import {OllamaClient} from '../lib/ollama-client.mjs';
import {AppError,safeError} from '../lib/errors.mjs';
import {openDatabase} from './db.mjs';
import {claimJob,markExpiredJobs,materialFromJob,pauseProvider,updateJob} from './jobs.mjs';
import {VllmClient} from './vllm-client.mjs';
import {collectPublicLink,resolveMapLocations} from './extractor-client.mjs';
import {GeminiClient} from './gemini-client.mjs';
import {saveDesktopCover} from './desktop-cover.mjs';
import {transcriberFromEnv} from './transcription.mjs';
import keyStore from '../../../config/keys.cjs';

const {getKey} = keyStore;

export function providerFromEnv(settings,env=process.env){
  if(settings.providerName==='ollama')return new OllamaClient({settings,baseUrl:env.OLLAMA_BASE_URL||'http://127.0.0.1:11434'});
  if(settings.providerName==='vllm')return new VllmClient({baseUrl:env.VLLM_BASE_URL,model:settings.model,apiKey:getKey('VLLM_API_KEY',env)});
  if(settings.providerName==='gemini')return new GeminiClient({apiKey:getKey('GEMINI_API_KEY',env),model:settings.model});
  throw new Error('MULTIUSER_AI_PROVIDER must be ollama, vllm, or gemini');
}
export function desktopPlaceResult(report){
  if(!report||report.status==='collection_failed')throw new AppError(report?.notes?.[0]||'Instagram 원본에 접근하지 못했습니다.',{code:'public_collection_failed'});
  const evidence=[],facts=[],addresses=[],place_names=[];
  const events=Array.isArray(report.events)?report.events:[];
  for(const [index,place] of (report.places||[]).entries()){
    const id=`desktop_${index}`,quote=place.evidence?.quote||'';
    evidence.push({id,kind:place.evidence?.kind||place.source||'link',text:quote,source_file:place.evidence?.file||null,time_seconds:place.evidence?.time_seconds??null});
    if(place.name){const fact={field:'place_name',value:place.name,evidence_ids:[id],source:place.source};facts.push(fact);place_names.push(fact);}
    if(place.address){const fact={field:'address',value:place.address,evidence_ids:[id],source:place.address_source||place.source};facts.push(fact);addresses.push(fact);}
  }
  const locations=(report.map_locations||[]).filter(loc=>Number.isFinite(loc.coordinates?.lat)&&Number.isFinite(loc.coordinates?.lng)).map(loc=>({...loc,source:'desktop_link',review_required:true,provider:loc.coordinate_source}));
  return{result:{title:report.ai_title||'Instagram 콘텐츠 분석',summary:report.ai_summary||`장소 ${report.places?.length||0}곳, 일정 ${events.length}건, 지도 위치 ${locations.length}곳`,content_kind:report.content_kind||'unknown',events,facts,limitations:report.notes||[],map_location:{status:locations.length?'needs_verification':'address_missing',addresses,place_names,locations,name_lookups:[],coordinates:null}},evidence,coverage:{kind:'cloud_run_link',content_kind:report.content_kind||'unknown',media_files:report.media_files||[],route:report.route||null},media_text:{visual:report.observed_text||[],audio:report.audio_transcripts||[],ocr:report.screen_text||[]}};
}
export async function processJob(db,job,{dataDir,provider,transcriber,prepare=prepareMedia,mapResolver=resolveMapLocations,desktopCollector=collectPublicLink,coverSaver=saveDesktopCover,leaseMs=20*60*1000}={}){
  const settings=JSON.parse(job.settings_json),workerId=job.worker_id;
  let material;
  const heartbeat=setInterval(()=>updateJob(db,job.id,workerId,{lease_until:Date.now()+leaseMs}),30000);heartbeat.unref();
  try{
    material=materialFromJob(job);
    if(material.collect_public){
      const report=await desktopCollector(job),mapped=desktopPlaceResult(report);
      try{
        const coverId=await coverSaver(db,job,report,{dataDir});
        mapped.coverage.cover_asset_id=coverId;
        if(!coverId)mapped.result.limitations.push('콘텐츠 대표 이미지를 확보하지 못했습니다.');
      }catch{
        mapped.result.limitations.push('콘텐츠 대표 이미지를 저장하지 못했습니다.');
      }
      updateJob(db,job.id,workerId,{status:'completed',result_json:JSON.stringify(mapped.result),coverage_json:JSON.stringify(mapped.coverage),evidence_json:JSON.stringify(mapped.evidence),media_text_json:JSON.stringify(mapped.media_text),completed_at:new Date().toISOString(),lease_until:null,worker_id:null});return;
    }
    const prepared=await prepare(material,path.join(dataDir,'work',job.user_id,job.id),settings);
    const mediaText={version:1,visual:[],audio:[],ocr:[]};
    try{mediaText.ocr=await readImageText(prepared.images);}catch{mediaText.ocr_error="문자 인식을 완료하지 못했습니다.";}
    updateJob(db,job.id,workerId,{coverage_json:JSON.stringify(prepared.coverage),evidence_json:JSON.stringify(prepared.evidence),media_text_json:JSON.stringify(mediaText)});
    if(prepared.images.length&&!provider.describeImage)throw new AppError('이미지를 텍스트로 변환하는 모델이 설정되지 않았습니다.',{code:'visual_text_unavailable'});
    for(const img of prepared.images){
      const observation=await provider.describeImage(img,{model:settings.model});
      mediaText.visual.push({evidence_id:img.id,kind:img.kind,time_seconds:img.time_seconds,scene:observation.scene,visible_text:observation.visible_text,objects:observation.objects,actions:observation.actions,uncertainties:observation.uncertainties,model:observation.model||settings.model});
      updateJob(db,job.id,workerId,{media_text_json:JSON.stringify(mediaText)});
    }
    const asr=prepared.audio.length?(transcriber===undefined?transcriberFromEnv():transcriber):null;
    if(prepared.audio.length&&!asr)throw new AppError('음성 전사 모델이 설정되지 않았습니다. ASR_PROVIDER를 설정하세요.',{code:'asr_not_configured'});
    for(const audio of prepared.audio){
      const transcript=await asr.transcribe(audio);
      mediaText.audio.push({evidence_id:audio.id,kind:'audio_transcript',text:transcript.text,segments:transcript.segments,language:transcript.language,model:transcript.model,duration_seconds:audio.duration_seconds});
      prepared.evidence.push({id:audio.id,kind:'audio_transcript',text:transcript.text,language:transcript.language,timing_precision:transcript.segments.length?'segment':'whole_audio'});
      updateJob(db,job.id,workerId,{media_text_json:JSON.stringify(mediaText),evidence_json:JSON.stringify(prepared.evidence)});
    }
    prepared.coverage.audio_status=prepared.audio.length?(mediaText.audio.some(a=>a.text)?'transcribed':'no_speech_detected'):'not_present';
    prepared.media_text=mediaText;
    const mediaAddresses=extractMediaAddresses({...mediaText,images:prepared.images});
    prepared.images=[];
    updateJob(db,job.id,workerId,{status:'summarizing',coverage_json:JSON.stringify(prepared.coverage)});
    let result;try{result=await provider.summarize(prepared,{sourceUrl:job.source_url,model:settings.model,maxOutputTokens:settings.maxOutputTokens});}catch(e){if(!['invalid_model_output','unknown_evidence','empty_model_output'].includes(e.code))throw e;result={result:{title:'Instagram 원문 분석',summary:'이미지·음성의 원문에서 주소 후보를 추출했습니다.',summary_evidence_ids:prepared.evidence.map(x=>x.id),topics:[],visible_text:[],facts:explicitCaptionAddresses(prepared.evidence.find(x=>x.kind==='caption')?.text||''),inferences:[],limitations:['AI 요약 형식 오류로 원문 주소 추출 결과만 제공합니다.']},evidence:prepared.evidence,usage:null};}
    result.result=structuredClone(result.result);
    const captionAddresses=explicitCaptionAddresses(prepared.evidence.find(x=>x.kind==='caption')?.text||'');
    for(const candidate of [...captionAddresses,...mediaAddresses]){
      const index=result.result.facts.findIndex(f=>f.field==='address'&&f.value===candidate.value&&JSON.stringify(f.evidence_ids)===JSON.stringify(candidate.evidence_ids));
      if(index>=0)result.result.facts[index]=candidate;else result.result.facts.push(candidate);
    }
    if(mediaText.ocr_error)result.result.limitations.push(mediaText.ocr_error);
    result.evidence=prepared.evidence;
    result.result.map_location={status:result.result.facts.some(f=>f.field==='address')?'needs_verification':'address_missing',addresses:result.result.facts.filter(f=>f.field==='address'),place_names:result.result.facts.filter(f=>f.field==='place_name'),coordinates:null};
    let mapped;
    try{mapped=await mapResolver(db,{facts:result.result.facts,evidence:prepared.evidence});}
    catch{mapped={locations:[],name_lookups:[],notes:['지도 장소 확인을 완료하지 못했습니다.']};}
    result.result.map_location.name_lookups=mapped.name_lookups;
    result.result.map_location.locations=mapped.locations;
    result.result.limitations.push(...(mapped.notes||[]));
    for(const location of mapped.locations.filter(x=>x.source==='place_name'&&x.address)){
      if(result.result.map_location.addresses.some(x=>x.value===location.address))continue;
      result.result.map_location.addresses.push({field:'address',value:location.address,evidence_ids:location.evidence_ids,source:'map_lookup',provider:location.provider,place_name:location.name,needs_review:true});
    }
    if(result.result.map_location.addresses.length)result.result.map_location.status='needs_verification';
    if(prepared.coverage.partial)result.result.limitations.push('제공된 원본과 추출한 프레임 범위만 분석했습니다.');
    updateJob(db,job.id,workerId,{status:'completed',result_json:JSON.stringify(result.result),coverage_json:JSON.stringify(prepared.coverage),evidence_json:JSON.stringify(result.evidence),media_text_json:JSON.stringify(mediaText),usage_json:JSON.stringify(result.usage),completed_at:new Date().toISOString(),lease_until:null,worker_id:null});
  }catch(e){
    db.transaction(()=>{
      if(!material?.collect_public&&[401,403,429].includes(e.status)){
        const target=e.code==='asr_error'||!/^[a-z][a-z0-9_-]{0,63}$/.test(settings.providerName||'')?'all_media':settings.providerName;
        pauseProvider(db,target,{status:e.status,code:e.code});
      }
      updateJob(db,job.id,workerId,{status:'failed',error_json:JSON.stringify({code:e.code||'processing_error',message:e instanceof AppError?safeError(e):'AI 작업 중 오류가 발생했습니다.'}),lease_until:null,worker_id:null});
    }).immediate();
  }finally{clearInterval(heartbeat);}
}
export async function runWorker({db,dataDir,providerFactory=providerFromEnv,concurrency=Number(process.env.WORKER_CONCURRENCY||1),pollMs=1000,signal}={}){
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw new Error('WORKER_CONCURRENCY must be 1-8');
  const workerId=crypto.randomUUID(),active=new Set();
  while(!signal?.aborted){
    markExpiredJobs(db);
    while(active.size<concurrency){
      const job=claimJob(db,workerId);if(!job)break;
      let provider,material,settings;
      try{material=materialFromJob(job);settings=JSON.parse(job.settings_json);if(!material.collect_public)provider=providerFactory(settings);}
      catch(e){
        db.transaction(()=>{
          if(material&&!material.collect_public&&settings){
            const target=/^[a-z][a-z0-9_-]{0,63}$/.test(settings.providerName||'')?settings.providerName:'all_media';
            pauseProvider(db,target,{status:503,code:'provider_config'});
          }
          updateJob(db,job.id,workerId,{status:'failed',error_json:JSON.stringify({code:'provider_config',message:'AI 서버 설정을 확인하세요.'}),lease_until:null,worker_id:null});
        }).immediate();
        continue;
      }
      const task=processJob(db,job,{dataDir,provider}).finally(()=>active.delete(task));active.add(task);
    }
    await new Promise(resolve=>setTimeout(resolve,pollMs));
  }
  await Promise.allSettled(active);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const dataDir=path.resolve(process.env.MULTIUSER_DATA_DIR||'.multiuser-data'),db=openDatabase(path.join(dataDir,'pinmap.sqlite'));
  const controller=new AbortController();for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>controller.abort());
  await runWorker({db,dataDir,signal:controller.signal});db.close();
}
