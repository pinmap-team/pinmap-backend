import test from 'node:test';
import assert from 'node:assert/strict';
import {parseInstagramJson,parseInstagramExport} from '../service/import.mjs';
test('direct JSON normalizes links and deduplicates repeated exported posts',async()=>{
 const record={label_values:[{label:'URL',href:'https://www.instagram.com/p/example/?igsh=tracking'}]};
 const input=Buffer.from(JSON.stringify([record,record]));
 assert.equal(parseInstagramJson(input).length,1);
 assert.equal((await parseInstagramExport(input))[0].url,'https://www.instagram.com/p/example/');
});
test('invalid JSON and unexpected export structure fail explicitly',()=>{
 assert.throws(()=>parseInstagramJson(Buffer.from('{')));
 assert.throws(()=>parseInstagramJson(Buffer.from('{}')));
});
