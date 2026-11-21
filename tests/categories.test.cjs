const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const handler=require('../api/content-save');
test('API and container use the same 24 category catalog',()=>{
 const catalog=require('../categories.json');
 assert.equal(catalog.length,24);assert.equal(new Set(catalog.map(c=>c.id)).size,24);
 assert.deepEqual(catalog,JSON.parse(fs.readFileSync('extractor/categories.json','utf8')));
});
