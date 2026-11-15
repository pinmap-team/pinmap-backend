import path from 'node:path';
import fs from 'node:fs';
import {openDatabase} from './db.mjs';
import {pausedProviders,resumeProvider} from './jobs.mjs';

const [command='status',providerName]=process.argv.slice(2);
if(command!=='status'&&command!=='resume'){
  throw new Error('Use `npm run queue -- status` or `npm run queue -- resume <provider>`');
}
if(command==='resume'&&!providerName){
  throw new Error('Specify the provider shown by `npm run queue -- status`');
}
const dataDir=path.resolve(process.env.MULTIUSER_DATA_DIR||'.multiuser-data');
const databaseFile=path.join(dataDir,'pinmap.sqlite');
if(!fs.existsSync(databaseFile)||!fs.statSync(databaseFile).isFile()){
  throw new Error('기존 작업 DB를 찾지 못했습니다. MULTIUSER_DATA_DIR를 확인하세요.');
}
const db=openDatabase(databaseFile);
try{
  if(command==='resume')console.log(JSON.stringify({resumed:providerName,changed:resumeProvider(db,providerName)}));
  else console.log(JSON.stringify({paused_providers:pausedProviders(db)}));
}finally{db.close();}
