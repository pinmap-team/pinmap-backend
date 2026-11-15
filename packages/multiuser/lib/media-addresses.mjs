const region='(?:서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기도?|강원(?:특별자치도|도)?|충청[남북]도|충[남북]|전라[남북]도|전북(?:특별자치도)?|전남|경상[남북]도|경[남북]|제주(?:특별자치도|도)?)';
export function addressSpans(text){
 const normalized=String(text||'').replace(/\s+/g,' ');
 const re=new RegExp(region+'\\s+(?:[가-힣0-9]+(?:시|군|구)\\s+){0,3}[가-힣0-9·.]+(?:로|길|동|리)\\s*\\d+(?:-\\d+)?(?:\\s*\\d+층)?','g');
 return [...new Set(normalized.match(re)||[])];
}
export function extractMediaAddresses({ocr=[],visual=[],audio=[],images=[]}={}){
 const candidates=[];
 const add=(text,source,evidence_id,time_seconds=null)=>{for(const address of addressSpans(text))candidates.push({field:'address',value:address,source,evidence_ids:[evidence_id],time_seconds,quote:String(text),verified:false});};
 for(const row of ocr){const img=images.find(x=>x.path===row.path);if(img)add((row.lines||[]).map(x=>x.text).join(' '),img.kind==='video_frame'?'video_ocr':'image_ocr',img.id,img.time_seconds??null);}
 for(const row of visual)add([row.scene,...(row.visible_text||[])].join(' '),'vision_candidate',row.evidence_id,row.time_seconds??null);
 for(const row of audio){if(row.segments?.length)for(const [i,s] of row.segments.entries())add(s.text,'audio',row.evidence_id,s.start_seconds);else add(row.text,'audio',row.evidence_id);}
 return candidates.filter((a,i,list)=>list.findIndex(b=>b.value===a.value&&b.source===a.source&&b.evidence_ids[0]===a.evidence_ids[0])===i);
}
