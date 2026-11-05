import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
// Only runtime-specific classes are stubbed; the actual Worker router and route handlers run.
vi.mock('agents/mcp',()=>({McpAgent:class {static serve(){throw new Error('MCP must not be reached');}}}));
vi.mock('../src/importer',()=>({ImportDO:class {}}));
import worker from '../src/index';
const token='A'.repeat(43);
let env:any; let ctx:any;
beforeEach(()=>{
  env={INGEST_SECRET:'legacy-test-only',PHONE_COMMAND_TOKEN_SHA256:createHash('sha256').update(token).digest('hex'),
    MCP_TOKEN:'mcp-test-only',FOOD_DELIVERY_MODE:'pushcut',GMAIL_OAUTH_ENABLED:'true',
    GMAIL_CLIENT_ID:'test',GMAIL_CLIENT_SECRET:'test',GMAIL_SENDER:'sender@example.com',
    GMAIL_REDIRECT_URI:'https://test/oauth/gmail/callback',GMAIL_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64'),
    DB:{prepare:vi.fn(()=>{throw Error('DB must not be touched');})},
    IMPORT_DO:{get:vi.fn(()=>{throw Error('Import must not be touched');})}};
  ctx={waitUntil:vi.fn()};
  vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No live network'));
});
afterEach(()=>vi.restoreAllMocks());
const legacyRoutes:[string,string][]=[
  ['POST','/ingest'],['POST','/upload-export'],['POST','/today'],['POST','/foods-seen'],
  ['GET','/pending'],['GET','/pending-all'],['GET','/pending-batch'],['GET','/pending-water'],['GET','/pending-weight'],
  ['POST','/sync-ack'],['POST','/ack-batch'],['POST','/cancel-pending'],['DELETE','/cancel-pending'],
];
it.each(legacyRoutes)('phone credential does not authorize legacy %s %s through any legacy transport',async(method,path)=>{
  const request=new Request(`https://test${path}?token=${token}`,{method,headers:{'x-phone-command-token':token,'x-ingest-secret':token},
    ...(method==='POST'?{body:JSON.stringify({secret:token,op:'insert',table:'days',rows:[]})}:{})});
  expect((await worker.fetch(request,env,ctx)).status).toBe(401);
  expect(env.DB.prepare).not.toHaveBeenCalled();expect(env.IMPORT_DO.get).not.toHaveBeenCalled();expect(ctx.waitUntil).not.toHaveBeenCalled();
});
it('phone credential cannot start Gmail OAuth or access the MCP endpoint',async()=>{
  expect((await worker.fetch(new Request('https://test/oauth/gmail/start',{method:'POST',headers:{'x-phone-command-token':token,'x-ingest-secret':token}}),env,ctx)).status).toBe(401);
  for(const path of ['/mcp',`/mcp/${token}`]) expect((await worker.fetch(new Request(`https://test${path}`,{headers:{'x-phone-command-token':token}}),env,ctx)).status).toBe(401);
  expect(env.DB.prepare).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it('retains existing ingest-secret authorization, including when no phone digest is set',async()=>{
  for(const configured of [undefined,env.PHONE_COMMAND_TOKEN_SHA256]) {
    env.PHONE_COMMAND_TOKEN_SHA256=configured;
    const response=await worker.fetch(new Request('https://test/ingest',{method:'POST',body:JSON.stringify({secret:env.INGEST_SECRET,op:'insert',table:'days',rows:[]})}),env,ctx);
    expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,inserted:0});
  }
  expect(env.DB.prepare).not.toHaveBeenCalled();
});
it('routes the read-only connectivity check without enabling delivery',async()=>{
  const response=await worker.fetch(new Request('https://test/commands/connectivity',{headers:{'x-phone-command-token':token}}),env,ctx);
  expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,scope:'email_commands',email_delivery_enabled:false});
  expect(env.DB.prepare).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
