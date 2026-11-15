import {explicitCaptionAddresses} from '../lib/address.mjs';
export function exportAddressResult(caption){
 const addresses=explicitCaptionAddresses(caption).map(a=>({...a,evidence_ids:['export_caption']}));
 return {summary:'내보내기 원문에서 추출한 주소 · 미디어 분석 상태는 별도 표시',map_location:{status:addresses.length?'address_needs_verification':'address_missing',addresses,coordinates:null}};
}
export function seedExportAddresses(db,userId=null){
 const rows=db.prepare("SELECT j.id,p.caption FROM jobs j JOIN posts p ON p.id=j.post_id AND p.user_id=j.user_id WHERE j.result_json IS NULL AND (? IS NULL OR j.user_id=?)").all(userId,userId);let extracted=0;
 for(const row of rows){const result=exportAddressResult(row.caption);extracted+=result.map_location.addresses.length;db.prepare('UPDATE jobs SET result_json=?,evidence_json=? WHERE id=? AND result_json IS NULL').run(JSON.stringify(result),JSON.stringify([{id:'export_caption',kind:'caption',text:row.caption}]),row.id);}
 return {posts:rows.length,addresses:extracted};
}
