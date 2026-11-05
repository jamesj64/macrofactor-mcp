import type { MacroFactorFood } from './mf-schema';
import { validateFoodPayload } from './nutrients';
import * as db from './db';
import { gmailConfigured, sendWake, findSentAttempt, trashWake, type GmailEnv } from './gmail-transport';

export interface CommandEnv extends GmailEnv {
  DB: D1Database; INGEST_SECRET: string; USER_TZ?: string;
  FOOD_DELIVERY_MODE?: string; GMAIL_RETRY_MINUTES?: string;
  GMAIL_TRASH_AFTER_SECONDS?: string; FOOD_REVIEW_KCAL?: string;
}
type Command = {
  id: string; request_key: string; payload: string; payload_hash: string; day: string;
  expires_at: number; state: string; validation: string; next_wake_at: number;
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
export const emailMode = (env: CommandEnv) => env.FOOD_DELIVERY_MODE === 'email';
const numberSetting = (value: string | undefined, fallback: number, min: number, max: number) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error('Invalid email bridge configuration');
  return n;
};
export function localDay(env: CommandEnv, now: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: env.USER_TZ || 'UTC', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(now));
}
const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), b => b.toString(16).padStart(2,'0')).join('');
const macroKeys = ['energy','protein','carbs','fat'] as const;

export function validateCommandFood(food: MacroFactorFood, cap = 3000): string[] {
  validateFoodPayload(food);
  const n = food.nutrients;
  const reasons: string[] = [];
  for (const [k, v] of Object.entries(n)) if (!Number.isFinite(v) || v! < 0) reasons.push(`invalid_${k}`);
  for (const k of macroKeys) if (n[k] == null) reasons.push(`missing_${k}`);
  if ((n.energy ?? 0) > cap) reasons.push('calories_need_review');
  if ((n.protein ?? 0) > 350 || (n.carbs ?? 0) > 800 || (n.fat ?? 0) > 300) reasons.push('macros_need_review');
  const estimate = 4*(n.protein ?? 0)+4*(n.carbs ?? 0)+9*(n.fat ?? 0)+7*(n.alcohol ?? 0);
  if (Math.abs((n.energy ?? 0)-estimate) > Math.max(100, (n.energy ?? 0)*0.25)) reasons.push('calorie_macro_mismatch');
  if (typeof food.serving === 'object') {
    const s = food.serving as unknown as Record<string, unknown>;
    if (typeof s.amount === 'number' && (!(s.amount > 0) || s.amount > 100)) reasons.push('serving_need_review');
    if (typeof s.weight === 'number' && (!(s.weight > 0) || s.weight > 5000)) reasons.push('serving_weight_need_review');
  }
  if (food.recipe?.length) {
    for (const k of macroKeys) {
      const sum = food.recipe.reduce((total, child) => total + (child.nutrients[k] ?? 0),0);
      if (Math.abs((n[k] ?? 0)-sum) > Math.max(k==='energy'?5:1, sum*0.05)) reasons.push(`recipe_${k}_mismatch`);
    }
  }
  return [...new Set(reasons)];
}

export async function createCommands(env: CommandEnv, foods: MacroFactorFood[], requestId?: string, now = Date.now()) {
  if (!gmailConfigured(env)) throw new Error('Email delivery is not configured; no command was created');
  if (!requestId || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) throw new Error('Invalid request_id');
  const old = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM pending_food)+(SELECT COUNT(*) FROM pending_batch)+
    (SELECT COUNT(*) FROM pending_water)+(SELECT COUNT(*) FROM pending_weight) AS n`).first<{n:number}>();
  if (old?.n) throw new Error('Legacy pending logs must be drained or cancelled before email delivery');
  const cap = numberSetting(env.FOOD_REVIEW_KCAL,3000,500,10000);
  const day = localDay(env,now);
  const records = [];
  const batchTooLarge=foods.reduce((sum,f)=>sum+(f.nutrients.energy??0),0)>cap;
  for (let i=0; i<foods.length; i++) {
    // A new intentional serving must not retain a previous command's marker.
    const food = {...foods[i], name: foods[i].name.replace(/\s*\[MF:[0-9a-f-]+\]/gi,'').trim()};
    const original = JSON.stringify(food);
    const digest = await hash(original);
    const key = `${requestId}:${i}`;
    const id = crypto.randomUUID();
    const reasons = validateCommandFood(food,cap);
    if (batchTooLarge && foods.length>1) reasons.push("meal_calories_need_review");
    records.push({id,key,digest,payload:JSON.stringify({...food,name:`${food.name} [MF:${id}]`}),reasons});
  }
  // Manifest binds the complete ordered meal to a caller retry key, even under concurrent retries.
  const manifest=await hash(JSON.stringify(records.map(r=>r.digest)));
  await env.DB.batch([
    env.DB.prepare('INSERT INTO food_command_requests VALUES (?,?) ON CONFLICT(request_id) DO NOTHING').bind(requestId,manifest),
    ...records.map(r => env.DB.prepare(`INSERT INTO food_commands
      (id,request_key,payload,payload_hash,created_at,day,expires_at,state,validation,next_wake_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM food_command_requests WHERE request_id=? AND manifest_hash=?)
      ON CONFLICT(request_key) DO NOTHING`)
      .bind(r.id,r.key,r.payload,r.digest,now,day,now+86400000,r.reasons.length?'held':'ready',JSON.stringify(r.reasons),now,requestId,manifest)),
  ]);
  const stored=await env.DB.prepare('SELECT manifest_hash FROM food_command_requests WHERE request_id=?').bind(requestId).first<{manifest_hash:string}>();
  if(stored?.manifest_hash!==manifest) throw new Error('request_id already belongs to a different meal; no new command created');
  const commands = [];
  for (const r of records) {
    const row = await env.DB.prepare('SELECT * FROM food_commands WHERE request_key=?').bind(r.key).first<Command>();
    if (!row || row.payload_hash !== r.digest) throw new Error('request_id was already used for different food; original command unchanged');
    commands.push({id:row.id,state:row.state,validation:JSON.parse(row.validation),name:JSON.parse(row.payload).name});
  }
  return { request_id:requestId, commands };
}

async function expire(env: CommandEnv, now: number) {
  await env.DB.prepare(`UPDATE food_commands SET state='expired' WHERE state='ready' AND (day<>? OR expires_at<=?)`).bind(localDay(env,now),now).run();
}
export async function commandStatus(env: CommandEnv) {
  await expire(env,Date.now());
  const rows = await env.DB.prepare(`SELECT id,state,payload,validation,created_at,confirmed_at,last_error FROM food_commands
    WHERE state NOT IN ('confirmed','cancelled','expired') OR created_at>? ORDER BY created_at DESC LIMIT 100`).bind(Date.now()-86400000).all();
  return rows.results.map((r:any)=>({id:r.id,state:r.state,name:JSON.parse(r.payload).name,validation:JSON.parse(r.validation),created_at:r.created_at,confirmed_at:r.confirmed_at,last_error:r.last_error}));
}
export async function cancelCommands(env: CommandEnv, id?: string) {
  // Cancels future execution/wakes. An already running app action can still complete.
  const r = await env.DB.prepare(`UPDATE food_commands SET state='cancelled'
    WHERE state IN ('ready','held','started','uncertain') ${id?'AND id=?':''} RETURNING id`).bind(...(id?[id]:[])).all();
  return r.results.length;
}
export async function handleCommand(request: Request, env: CommandEnv): Promise<Response> {
  if (!emailMode(env)) return json({error:'not_found'},404);
  if (!env.INGEST_SECRET || request.headers.get('x-ingest-secret')!==env.INGEST_SECRET) return json({error:'unauthorized'},401);
  const m = /^\/commands\/([0-9a-f-]{36})(?:\/(start|receipt))?$/.exec(new URL(request.url).pathname);
  if (!m) return json({error:'not_found'},404);
  const now = Date.now(); await expire(env,now);
  let c = await env.DB.prepare('SELECT * FROM food_commands WHERE id=?').bind(m[1]).first<Command>();
  if (!c) return json({error:'not_found'},404);
  if (!m[2]) {
    if (request.method!=='GET') return json({error:'GET only'},405);
    const food = JSON.parse(c.payload);
    const mode = c.state==='ready'?'execute':['started','uncertain'].includes(c.state)?'verify':'stop';
    return json({id:c.id,state:c.state,mode,food,food_json:JSON.stringify([food]),expected_name:food.name,expires_at:c.expires_at});
  }
  if (request.method!=='POST') return json({error:'POST only'},405);
  if (m[2]==='start') {
    const changed=await env.DB.prepare(`UPDATE food_commands SET state='started',started_at=?
      WHERE id=? AND state='ready' AND day=? AND expires_at>? RETURNING id`).bind(now,c.id,localDay(env,now),now).all();
    const execute=changed.results.length===1;
    return json({execute,decision:execute?'execute':'stop'});
  }
  let body:any;
  try { body=await request.json(); } catch { return json({error:'invalid_json'},400); }
  if (body?.status==='uncertain') {
    await env.DB.prepare(`UPDATE food_commands SET state='uncertain' WHERE id=? AND state='started'`).bind(c.id).run();
    return json({ok:true,status:'uncertain'});
  }
  if (body?.status!=='confirmed') return json({error:'invalid_status'},400);
  if (c.state==='cancelled') return json({error:'cancelled'},409);
  const expected=JSON.parse(c.payload) as MacroFactorFood;
  const observed=body.observed;
  const matches=observed?.name===expected.name && macroKeys.every(k=>typeof observed?.nutrients?.[k]==='number'
    && Number.isFinite(observed.nutrients[k]) && Math.abs(observed.nutrients[k]-(expected.nutrients[k]??0))<=Math.max(k==='energy'?2:0.2,(expected.nutrients[k]??0)*0.02));
  if (!matches) {
    await env.DB.prepare(`UPDATE food_commands SET state='held',last_error='receipt_mismatch'
      WHERE id=? AND state NOT IN ('confirmed','cancelled')`).bind(c.id).run();
    return json({error:'receipt_mismatch',needs_review:true},409);
  }
  // Record receipt first; summary upload failure must never authorize another app write.
  const receipt=JSON.stringify({observed,summary:body.summary??null,received_at:now});
  await env.DB.prepare(`UPDATE food_commands SET state='confirmed',confirmed_at=COALESCE(confirmed_at,?),receipt=?,last_error=NULL
    WHERE id=? AND state<>'cancelled'`).bind(now,receipt,c.id).run();
  let summary_saved=false;
  if (body.summary && typeof body.summary==='object') {
    try {
      const summary=db.extractTodaySummary(body.summary);
      const day=localDay(env,now);
      await db.upsertToday(env.DB,day,summary,JSON.stringify(body.summary),now,'email-command');
      await db.recordDaySnapshot(env.DB,day,summary.consumed,summary.remaining);
      summary_saved=true;
    } catch { /* Receipt persists; next MF Refresh can repair totals. */ }
  }
  return json({ok:true,status:'confirmed',summary_saved});
}

export async function processCommandMail(env: CommandEnv, now=Date.now(), transport={sendWake,findSentAttempt,trashWake}) {
  if (!emailMode(env) || !gmailConfigured(env)) return;
  const interval=numberSetting(env.GMAIL_RETRY_MINUTES,10,1,1440)*60000;
  const cleanup=numberSetting(env.GMAIL_TRASH_AFTER_SECONDS,60,10,86400)*1000;
  await expire(env,now);
  // A response-lost send is never blindly retried as the same attempt. Reconcile exact marker first.
  await env.DB.prepare(`UPDATE command_mail_attempts SET state='send_unknown' WHERE state='sending' AND created_at<?`).bind(now-120000).run();
  const old=await env.DB.prepare(`SELECT * FROM command_mail_attempts WHERE state IN ('sent','send_unknown') AND cleanup_at<=? AND next_check_at<=? AND owner_account=? ORDER BY next_check_at,cleanup_at LIMIT 20`).bind(now,now,env.GMAIL_SENDER).all();
  for (const a of old.results as any[]) {
    if (a.owner_account!==env.GMAIL_SENDER) continue; // Never trash under a different configured identity.
    const lock=await env.DB.prepare('UPDATE command_mail_attempts SET next_check_at=? WHERE id=? AND next_check_at<=? RETURNING id').bind(now+60000,a.id,now).all();
    if (!lock.results.length) continue;
    try {
      const ids=a.gmail_message_id?[a.gmail_message_id]:await transport.findSentAttempt(env,a.id);
      if (!ids.length) { await env.DB.prepare('UPDATE command_mail_attempts SET next_check_at=? WHERE id=?').bind(now+900000,a.id).run(); continue; }
      for (const id of ids) await transport.trashWake(env,id);
      await env.DB.prepare(`UPDATE command_mail_attempts SET state='trashed',last_error=NULL WHERE id=?`).bind(a.id).run();
    } catch { await env.DB.prepare(`UPDATE command_mail_attempts SET last_error='cleanup_failed' WHERE id=?`).bind(a.id).run(); }
  }
  const due=await env.DB.prepare(`SELECT id FROM food_commands WHERE state IN ('ready','started','uncertain') AND next_wake_at<=? ORDER BY next_wake_at LIMIT 10`).bind(now).all();
  for (const command of due.results as {id:string}[]) {
    const attempt=crypto.randomUUID();
    // D1 batch transaction reserves one due command and records attempt using the unique reservation time/token.
    const r=await env.DB.batch([
      env.DB.prepare(`INSERT INTO command_mail_attempts (id,command_id,state,created_at,cleanup_at,owner_account)
        SELECT ?,id,'reserved',?,?,? FROM food_commands WHERE id=? AND state IN ('ready','started','uncertain') AND next_wake_at<=?`)
        .bind(attempt,now,now+cleanup,env.GMAIL_SENDER,command.id,now),
      env.DB.prepare(`UPDATE food_commands SET next_wake_at=? WHERE id=? AND EXISTS(SELECT 1 FROM command_mail_attempts WHERE id=?)`).bind(now+interval,command.id,attempt),
    ]);
    if (!r[0].meta.changes) continue;
  }
  const reserved=await env.DB.prepare(`SELECT a.id,a.command_id FROM command_mail_attempts a JOIN food_commands c ON c.id=a.command_id WHERE a.state='reserved' AND c.state IN ('ready','started','uncertain') ORDER BY a.created_at LIMIT 10`).all();
  for (const a of reserved.results as {id:string;command_id:string}[]) {
    const claimed=await env.DB.prepare(`UPDATE command_mail_attempts SET state='sending',created_at=?,cleanup_at=? WHERE id=? AND state='reserved'
      AND EXISTS(SELECT 1 FROM food_commands WHERE id=command_id AND state IN ('ready','started','uncertain')) RETURNING id`).bind(now,now+cleanup,a.id).all();
    if (!claimed.results.length) continue;
    try {
      const sent=await transport.sendWake(env,a.command_id,a.id);
      await env.DB.prepare(`UPDATE command_mail_attempts SET state='sent',gmail_message_id=?,last_error=NULL WHERE id=?`).bind(sent.messageId,a.id).run();
    } catch { await env.DB.prepare(`UPDATE command_mail_attempts SET state='send_unknown',last_error='send_outcome_unknown' WHERE id=?`).bind(a.id).run(); }
  }
}
