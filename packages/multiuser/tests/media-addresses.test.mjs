import test from 'node:test';import assert from 'node:assert/strict';
import {extractMediaAddresses,addressSpans} from '../lib/media-addresses.mjs';
test('image, video OCR, vision and timed speech retain independent source evidence',()=>{
 const r=extractMediaAddresses({images:[{id:'i',kind:'image',path:'/i'},{id:'v',kind:'video_frame',path:'/v',time_seconds:3}],ocr:[{path:'/i',lines:[{text:'서울 강동구'},{text:'천호동 332-1'}]},{path:'/v',lines:[{text:'서울 마포구 와우산로 12'}]},{path:'/unknown',lines:[{text:'서울 강남구 테헤란로 10'}]}],visual:[{evidence_id:'v',scene:'카페',visible_text:['서울 마포구 와우산로 12']}],audio:[{evidence_id:'a',segments:[{text:'주소는 서울 용산구 회나무로 8 입니다.',start_seconds:4.2}]}]});
 assert.deepEqual(r.map(x=>x.source),['image_ocr','video_ocr','vision_candidate','audio']);assert.equal(r[1].time_seconds,3);assert.equal(r[3].time_seconds,4.2);assert.deepEqual(r[3].evidence_ids,['a']);assert.ok(r.every(x=>x.verified===false));
});
test('place name alone never becomes a fabricated address',()=>assert.deepEqual(addressSpans('성수동의 LOW ANGLE CLUB'),[]));
