import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createCommands,handleCommand,processCommandMail,cancelCommands} from '../src/email-commands';
let sql:DatabaseSync; let env:any;
const now=Date.parse('2026-11-05T18:00:00Z');
const food:any={source:'test',icon:'foodDefault',name:'Synthetic sandwich',serving:'one',nutrients:{energy:500,protein:30,carbs:50,fat:20}};
class Stmt { values:any[]=[]; constructor(public query:string){} bind(...v:any[]){this.values=v;return this;}
 allSync(){return {results:sql.prepare(this.query).all(...this.values),meta:{changes:Number(sql.prepare('SELECT changes() n').get()!.n)}};}
 async all(){return this.allSync();} async first(){return sql.prepare(this.query).get(...this.values)??null;}
 async run(){const r=sql.prepare(this.query).run(...this.values);return {meta:{changes:Number(r.changes)}};}}
beforeEach(()=>{vi.spyOn(Date,'now').mockReturnValue(now);sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../migrations/0003_email_commands.sql',import.meta.url),'utf8'));
 for(const table of ['food','batch','water','weight'])sql.exec(`CREATE TABLE pending_${table}(id INTEGER)`);
 env={DB:{prepare:(q:string)=>new Stmt(q),batch:async(ss:Stmt[])=>{sql.exec('BEGIN');try{const rows=ss.map(s=>s.allSync());sql.exec('COMMIT');return rows;}catch(e){sql.exec('ROLLBACK');throw e;}}},
 INGEST_SECRET:'test-only',USER_TZ:'UTC',FOOD_DELIVERY_MODE:'email',GMAIL_CLIENT_ID:'test',GMAIL_CLIENT_SECRET:'test',GMAIL_REFRESH_TOKEN:'test',GMAIL_SENDER:'test@example.com',GMAIL_RECIPIENT:'test@example.com'};
});
afterEach(()=>{sql.close();vi.restoreAllMocks();});
const api=(id:string,path='',body?:any)=>handleCommand(new Request(`https://test/commands/${id}${path}`,{method:path?'POST':'GET',headers:{'x-ingest-secret':'test-only'},...(body?{body:JSON.stringify(body)}:{})}),env);
const create=async(key='request1')=>(await createCommands(env,[food],key,now)).commands[0].id;
it('requires immutable caller key and retries do not insert a second command or a changed partial batch',async()=>{
 await expect(createCommands(env,[food],undefined,now)).rejects.toThrow();
 const id=await create();expect(await create()).toBe(id);
 await expect(createCommands(env,[{...food,nutrients:{...food.nutrients,energy:600}},food],'request1',now)).rejects.toThrow();
 expect(sql.prepare('SELECT count(*) n FROM food_commands').get()!.n).toBe(1);
});
it('concurrent starts grant once; unknown result never reexecutes; exact repeated receipt succeeds',async()=>{
 const id=await create();const before=await (await api(id)).json() as any;
 const starts=await Promise.all([api(id,'/start'),api(id,'/start')]);const values=await Promise.all(starts.map(r=>r.json())) as any[];
 expect(values.filter(x=>x.execute)).toHaveLength(1);expect(values.filter(x=>x.decision==='execute')).toHaveLength(1);
 await api(id,'/receipt',{status:'uncertain'});expect((await (await api(id)).json() as any).mode).toBe('verify');
 expect((await (await api(id,'/start')).json() as any).execute).toBe(false);
 const receipt={status:'confirmed',observed:{name:before.expected_name,nutrients:food.nutrients}};
 expect((await api(id,'/receipt',receipt)).status).toBe(200);expect((await api(id,'/receipt',receipt)).status).toBe(200);
 expect((await (await api(id)).json() as any).mode).toBe('stop');
 expect(JSON.parse(before.food_json)).toHaveLength(1);
});
it('scoped phone authorization supports fetch/start/receipt without changing one-shot execution',async()=>{
 const token='A'.repeat(43); // Nonrandom test fixture, never a provisioned credential.
 env.PHONE_COMMAND_TOKEN_SHA256=createHash('sha256').update(token).digest('hex');
 const id=await create();
 const phone=(path='',body?:any)=>handleCommand(new Request(`https://test/commands/${id}${path}`,{
  method:path?'POST':'GET',headers:{'x-phone-command-token':token},...(body?{body:JSON.stringify(body)}:{})}),env);
 const before=await (await phone()).json() as any;
 expect(before.id).toBe(id);expect(before.mode).toBe('execute');
 const starts=await Promise.all([phone('/start'),phone('/start')]);
 const values=await Promise.all(starts.map(r=>r.json())) as any[];
 expect(values.filter(x=>x.execute)).toHaveLength(1);
 expect((await phone('/receipt',{status:'uncertain'})).status).toBe(200);
 expect((await (await phone()).json() as any).mode).toBe('verify');
 expect((await (await phone('/start')).json() as any).execute).toBe(false);
 const receipt={status:'confirmed',observed:{name:before.expected_name,nutrients:food.nutrients}};
 expect((await phone('/receipt',receipt)).status).toBe(200);
 expect((await phone('/receipt',receipt)).status).toBe(200);
 expect((await (await phone()).json() as any).mode).toBe('stop');
 expect(sql.prepare('SELECT count(*) n FROM food_commands').get()!.n).toBe(1);
 expect(sql.prepare('SELECT count(*) n FROM command_mail_attempts').get()!.n).toBe(0);
});
it('phone receipt preserves the existing optional summary behavior without reopening execution',async()=>{
 sql.close();sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 sql.exec(readFileSync(new URL('../migrations/0003_email_commands.sql',import.meta.url),'utf8'));
 const token='A'.repeat(43);
 env.PHONE_COMMAND_TOKEN_SHA256=createHash('sha256').update(token).digest('hex');
 const id=await create();const before=await (await api(id)).json() as any;
 await api(id,'/start');
 const response=await handleCommand(new Request(`https://test/commands/${id}/receipt`,{
  method:'POST',headers:{'x-phone-command-token':token},body:JSON.stringify({status:'confirmed',
   observed:{name:before.expected_name,nutrients:food.nutrients},summary:{consumed:food.nutrients}})}),env);
 expect(await response.json()).toEqual({ok:true,status:'confirmed',summary_saved:true});
 expect(sql.prepare('SELECT calories,source FROM today_summary').get()).toMatchObject({calories:500,source:'email-command'});
 expect(sql.prepare('SELECT calories,source FROM days').get()).toMatchObject({calories:500,source:'live'});
 expect((await (await api(id,'/start')).json() as any).execute).toBe(false);
 expect(sql.prepare('SELECT count(*) n FROM command_mail_attempts').get()!.n).toBe(0);
});
it('15k kcal or observed mismatch is held, and stale day cannot start',async()=>{
 const big=await createCommands(env,[{...food,nutrients:{...food.nutrients,energy:15000}}],'big',now);expect(big.commands[0].state).toBe('held');
 const id=await create();expect((await api(id,'/receipt',{status:'confirmed',observed:{name:'wrong',nutrients:food.nutrients}})).status).toBe(409);
 expect((await (await api(id,'/start')).json() as any).execute).toBe(false);
 const tomorrow=await create('tomorrow');vi.mocked(Date.now).mockReturnValue(now+86400000);
 expect((await (await api(tomorrow,'/start')).json() as any).execute).toBe(false);
});
it('sends once per due interval, trashes independently, and stops after receipt',async()=>{
 const id=await create();const t={sendWake:vi.fn(async()=>({messageId:'mail1'})),findSentAttempt:vi.fn(async()=>[]),trashWake:vi.fn(async()=>{})};
 await Promise.all([processCommandMail(env,now,t),processCommandMail(env,now,t)]);expect(t.sendWake).toHaveBeenCalledTimes(1);
 await processCommandMail(env,now+60000,t);expect(t.trashWake).toHaveBeenCalledWith(env,'mail1');
 await processCommandMail(env,now+600000,t);expect(t.sendWake).toHaveBeenCalledTimes(2);
 const row=await (await api(id)).json() as any;await api(id,'/receipt',{status:'confirmed',observed:{name:row.expected_name,nutrients:food.nutrients}});
 await processCommandMail(env,now+1200000,t);expect(t.sendWake).toHaveBeenCalledTimes(2);
});
it('lost send response reconciles exact attempt; cancelled reserved messages cannot block new sends',async()=>{
 const id=await create();const t={sendWake:vi.fn(async()=>{throw Error('lost');}),findSentAttempt:vi.fn(async()=>['reconciled']),trashWake:vi.fn(async()=>{})};
 await processCommandMail(env,now,t);await processCommandMail(env,now+60000,t);expect(t.findSentAttempt).toHaveBeenCalledTimes(1);expect(t.trashWake).toHaveBeenCalledWith(env,'reconciled');
 await cancelCommands(env,id);
 for(let i=0;i<10;i++)sql.prepare("INSERT INTO command_mail_attempts(id,command_id,state,created_at,cleanup_at,owner_account) VALUES (?,?,'reserved',?,?,?)").run('blocked'+i,id,now,now,env.GMAIL_SENDER);
 await create('second');t.sendWake=vi.fn(async()=>({messageId:'next'})) as any;
 await processCommandMail(env,now+120000,t);expect(t.sendWake).toHaveBeenCalledTimes(1);
});
it('does not activate without config, auth or with nonempty old queue',async()=>{
 const id=await create();env.FOOD_DELIVERY_MODE=undefined;expect((await api(id)).status).toBe(404);
 env.FOOD_DELIVERY_MODE='email';expect((await handleCommand(new Request('https://test/commands/'+id),env)).status).toBe(401);
 sql.exec('INSERT INTO pending_food VALUES (1)');await expect(create('blocked')).rejects.toThrow('Legacy');
});

it('starts email cleanup lifetime after a delayed send finishes, not at scheduler tick start',async()=>{
 await create();
 const t={sendWake:vi.fn(async()=>{vi.mocked(Date.now).mockReturnValue(now+120000);return {messageId:'delayed'};}),findSentAttempt:vi.fn(async()=>[]),trashWake:vi.fn(async()=>{})};
 await processCommandMail(env,now,t);
 expect(sql.prepare('SELECT cleanup_at FROM command_mail_attempts').get()!.cleanup_at).toBe(now+180000);
 await processCommandMail(env,now+179999,t);expect(t.trashWake).not.toHaveBeenCalled();
 await processCommandMail(env,now+180000,t);expect(t.trashWake).toHaveBeenCalledWith(env,'delayed');
});
