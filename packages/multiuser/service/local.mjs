import {createMultiuserApp} from './api.mjs';
import {runWorker} from './worker.mjs';

const app=await createMultiuserApp({localTest:true});
const host=process.env.MULTIUSER_HOST||'127.0.0.1';
const port=Number(process.env.MULTIUSER_PORT||8200);
const controller=new AbortController();
await new Promise((resolve,reject)=>app.server.once('error',reject).listen(port,host,resolve));
console.log(`Pinmap local API: http://${host}:${port}/api/me`);
if(process.env.PINMAP_FRONTEND_DIR)console.log(`Pinmap local web: http://${host}:${port}/index.html?mode=development`);
const work=runWorker({db:app.db,dataDir:app.dataDir,signal:controller.signal});
let closing=false;
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{
  if(closing)return;closing=true;controller.abort();
  await new Promise(resolve=>app.server.close(resolve));
  await work;app.db.close();process.exit(0);
});
await work;
