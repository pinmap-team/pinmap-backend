import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);
export async function readImageText(images){
 if(process.platform!=='darwin'||!images.length)return [];
 const {stdout}=await exec('swift',[fileURLToPath(new URL('../scripts/ocr.swift',import.meta.url)),...images.map(x=>x.path)],{timeout:180000,maxBuffer:4*1024*1024});
 return stdout.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
}
