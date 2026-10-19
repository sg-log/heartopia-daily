import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export async function readPrivateSources({apiUrl,adminKey,fetcher=fetch}) {
  if(!adminKey) throw Error('privateKeyMissing');
  const response=await fetcher(apiUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'getWeatherPrivateSources',adminKey}),signal:AbortSignal.timeout(45000)});
  if(!response.ok) throw Error('privateSourceReadFailed');const data=await response.json();
  if(data.ok!==true || !Array.isArray(data.handles) || data.handles.length>10 || data.handles.some(h=>typeof h!=='string'||!/^[A-Za-z0-9_]{1,15}$/.test(h))) throw Error('privateSourceReadFailed');
  return {handles:[...new Set(data.handles)]};
}
async function main() {
  const html=await fs.readFile('index.html','utf8'), apiUrl=html.match(/const WEATHER_API_URL\s*=\s*"([^"]+)"/)?.[1];
  const config=await readPrivateSources({apiUrl,adminKey:process.env.WEATHER_ADMIN_KEY});
  const target=process.argv[2];if(!target) throw Error('missingPrivatePath');
  await fs.writeFile(target,JSON.stringify(config),{mode:0o600});
  console.log(JSON.stringify({configuredAccounts:config.handles.length}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(()=>{console.error('Private weather source setup failed; values were withheld.');process.exitCode=1;});
