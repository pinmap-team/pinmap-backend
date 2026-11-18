const {test}=require('node:test'),assert=require('node:assert/strict');
test('stored place IDs get a fresh photo reference and required attribution',async()=>{
 const {getGooglePlacePhoto}=await import('../lib/google-place-photo.mjs');let calls=[];
 const photo=await getGooglePlacePhoto({google_place_id:'ChIJExampleId',name:'시시',coordinates:{lat:37.5,lng:127}},{key:'secret',fetcher:async(url,options)=>{
  calls.push({url:String(url),options});
  return calls.length===1?Response.json({id:'ChIJExampleId',displayName:{text:'시시'},location:{latitude:37.5,longitude:127},photos:[{name:'places/ChIJExampleId/photos/fresh',authorAttributions:[{displayName:'촬영자',uri:'https://www.google.com/maps/contrib/1'}]}]}):Response.json({photoUri:'https://lh3.googleusercontent.com/photo'});
 }});
 assert.equal(calls.length,2);assert.ok(!calls.some(c=>c.url.includes('searchText')));assert.equal(photo.attributions[0].name,'촬영자');assert.ok(photo.google_maps_uri.startsWith('https://www.google.com/maps/'));assert.equal(photo.place_id,'ChIJExampleId');
});
test('stale or mismatched place IDs never return a nearby unrelated photo',async()=>{
 const {getGooglePlacePhoto}=await import('../lib/google-place-photo.mjs');
 const p=await getGooglePlacePhoto({google_place_id:'ChIJExampleId',name:'시시',coordinates:{lat:37.5,lng:127}},{key:'secret',fetcher:async()=>Response.json({id:'ChIJExampleId',displayName:{text:'다른 상점'},location:{latitude:37.5,longitude:127},photos:[{name:'places/ChIJExampleId/photos/wrong'}]})});assert.equal(p,null);
});
