import fs from 'node:fs/promises';
import {AppError} from '../lib/errors.mjs';
import {RESULT_SCHEMA,SYSTEM_PROMPT,VISUAL_TEXT_SCHEMA,VISUAL_TEXT_PROMPT,validateResult,validateVisualText} from '../lib/contract.mjs';

export class GeminiClient {
  constructor({apiKey,model='gemini-2.5-flash',fetchImpl=fetch}={}){
    if(!apiKey)throw new Error('GEMINI_API_KEY is required');
    if(!/^gemini-[a-zA-Z0-9.-]+$/.test(model))throw new Error('Invalid Gemini model');
    this.apiKey=apiKey;this.model=model;this.fetch=fetchImpl;this.supportsAudio=false;
  }
  async generate({parts,prompt,schema,model,signal,maxOutputTokens}){
    if(!/^gemini-[a-zA-Z0-9.-]+$/.test(model))throw new AppError('Gemini 모델 설정이 올바르지 않습니다.',{code:'provider_config'});
    const endpoint=`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    let response;
    try{response=await this.fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':this.apiKey},body:JSON.stringify({systemInstruction:{parts:[{text:prompt}]},contents:[{role:'user',parts}],generationConfig:{responseMimeType:'application/json',responseJsonSchema:schema,maxOutputTokens,...(model==='gemini-2.5-flash'?{thinkingConfig:{thinkingBudget:0}}:{})}}),signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(900000)]),redirect:'error'});}
    catch{if(signal?.aborted)throw new AppError('작업을 취소했습니다.',{code:'cancelled',status:409});throw new AppError('Gemini 서버와 연결이 끊겼습니다. 중복 호출을 피하려고 자동 재호출하지 않습니다.',{code:'ambiguous_network_failure',status:502});}
    let body;try{body=await response.json();}catch{throw new AppError('Gemini 응답을 읽지 못했습니다.',{code:'invalid_provider_response',status:502});}
    if(!response.ok||body?.error){const code=response.status===429?'provider_rate_limited':response.status===401||response.status===403?'provider_auth_error':'provider_error';throw new AppError('Gemini 요청이 실패했습니다. 키, 사용 한도, 모델 설정을 확인하세요.',{code,status:response.status||502});}
    const candidate=body?.candidates?.[0];
    if(candidate?.finishReason!=='STOP')throw new AppError('Gemini 응답이 끝까지 생성되지 않았습니다.',{code:'incomplete_response',status:502});
    const output=candidate.content?.parts?.filter(part=>typeof part.text==='string').map(part=>part.text).join('')||'';
    let value;try{value=JSON.parse(output);}catch{throw new AppError('Gemini 응답이 JSON이 아닙니다.',{code:'invalid_model_output',status:502});}
    return{value,usage:body.usageMetadata||null,response_id:body.responseId||null,request_id:response.headers?.get?.('x-request-id')||null,model:body.modelVersion||model};
  }
  async describeImage(img,{signal,model=this.model}={}){
    const bytes=await fs.readFile(img.path);
    if(bytes.length>12*1024*1024)throw new AppError('Gemini에 보낼 이미지가 너무 큽니다. 12MB 이하로 줄여 다시 등록하세요.',{code:'media_too_large',status:413});
    const {value,usage,model:usedModel}=await this.generate({parts:[{text:JSON.stringify({evidence_id:img.id,kind:img.kind,time_seconds:img.time_seconds})},{inline_data:{mime_type:img.mime,data:bytes.toString('base64')}}],prompt:VISUAL_TEXT_PROMPT,schema:VISUAL_TEXT_SCHEMA,model,signal,maxOutputTokens:700});
    return{...validateVisualText(value),model:usedModel,usage};
  }
  async summarize(prepared,{sourceUrl,signal,model=this.model,maxOutputTokens=2400}={}){
    if(!prepared.images.length&&!prepared.media_text?.visual?.length&&!prepared.media_text?.audio?.length&&!prepared.evidence.some(e=>e.kind==='caption'))throw new AppError('분석할 자료가 없습니다.',{code:'missing_input'});
    const evidence=prepared.evidence.map(x=>({...x}));
    const promptEvidence=evidence.map(e=>e.kind==='audio_transcript'&&prepared.media_text?.audio?.length?{...e,text:undefined}:e);
    const parts=[{text:JSON.stringify({source_url:sourceUrl,coverage:prepared.coverage,evidence:promptEvidence,media_text:prepared.media_text,visual_input_order:prepared.images.map(x=>({evidence_id:x.id,kind:x.kind,time_seconds:x.time_seconds}))})}];
    for(const img of prepared.images){const bytes=await fs.readFile(img.path);if(bytes.length>12*1024*1024)throw new AppError('Gemini에 보낼 이미지가 너무 큽니다. 12MB 이하로 줄여 다시 등록하세요.',{code:'media_too_large',status:413});parts.push({text:`evidence_id=${img.id}`},{inline_data:{mime_type:img.mime,data:bytes.toString('base64')}});}
    const output=await this.generate({parts,prompt:SYSTEM_PROMPT,schema:RESULT_SCHEMA,model,signal,maxOutputTokens});
    validateResult(output.value,evidence);
    return{result:output.value,evidence,response_id:output.response_id,request_id:output.request_id,usage:output.usage,model:output.model};
  }
}
