import test from 'node:test';import assert from 'node:assert/strict';
import {explicitCaptionAddresses} from '../lib/address.mjs';
test('explicit address extraction preserves original lines and never guesses from a place name',()=>{
 assert.deepEqual(explicitCaptionAddresses('천호공원 앞 카페'),[]);
 const result=explicitCaptionAddresses('📍서울 강동구 천호동 332-1\n📍서울 강동구 천호동 332-1');
 assert.equal(result.length,1);assert.equal(result[0].value,'서울 강동구 천호동 332-1');assert.equal(result[0].verified,false);
});

test('actual library post checkmark prefix preserves address and caption provenance',()=>{
 const caption='📍국립스포츠박물관 도서관\n✔️ 서울 송파구 올림픽로 424\n⏰ 화-일 09:30~17:30 / 월요일 휴관';
 const result=explicitCaptionAddresses(caption);
 assert.equal(result.length,1);assert.equal(result[0].value,'서울 송파구 올림픽로 424');assert.equal(result[0].source,'caption');assert.equal(result[0].quote,'✔️ 서울 송파구 올림픽로 424');assert.deepEqual(result[0].evidence_ids,['caption']);
});
test('bullets, labels, numbered lists and inline addresses work without inventing addresses',()=>{
 for(const prefix of ['✔️ ','✅ ','• ','1. ','주소: ','위치 : ','찾아오시는 길은 '])assert.equal(explicitCaptionAddresses(prefix+'서울 송파구 올림픽로 424')[0]?.value,'서울 송파구 올림픽로 424');
 assert.deepEqual(explicitCaptionAddresses('국립스포츠박물관 도서관\n화-일 09:30~17:30'),[]);
 const r=explicitCaptionAddresses('서울 송파구 올림픽로 424 / 서울 강동구 천호동 332-1\n✔️ 서울 송파구 올림픽로 424');assert.equal(r.length,2);
});
