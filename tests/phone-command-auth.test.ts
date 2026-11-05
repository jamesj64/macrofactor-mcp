import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { authorizePhoneCommandRequest, phoneCommandRouteAllowed } from '../src/phone-command-auth';
import { handleCommand } from '../src/email-commands';

// Static, deliberately nonrandom test-only input. Never provision this as a credential.
const token = 'A'.repeat(43);
const digest = createHash('sha256').update(token).digest('hex');
const id = '00000000-0000-4000-8000-000000000001';
const paths: [string, string][] = [
  ['GET', `/commands/${id}`], ['POST', `/commands/${id}/start`],
  ['POST', `/commands/${id}/receipt`], ['GET', '/commands/connectivity'],
];
const request = (path = paths[0][1], method = 'GET', headers: Record<string, string> = {'x-phone-command-token':token}) =>
  new Request(`https://test${path}`, {method, headers});
let env: any;

beforeEach(() => {
  env = {INGEST_SECRET:'legacy-test-only', PHONE_COMMAND_TOKEN_SHA256:digest, FOOD_DELIVERY_MODE:'email',
    DB:{prepare:vi.fn(() => {throw new Error('DB must not be touched');})}};
});
afterEach(() => vi.restoreAllMocks());

describe('explicit phone credential scope', () => {
  it.each(paths)('accepts only the intended %s %s operation', async (method, path) => {
    expect(phoneCommandRouteAllowed(request(path, method))).toBe(true);
    expect(await authorizePhoneCommandRequest(request(path, method), env)).toBe(true);
  });
  it.each([
    ['POST', `/commands/${id}`], ['GET', `/commands/${id}/start`], ['GET', `/commands/${id}/receipt`],
    ['HEAD', `/commands/${id}`], ['OPTIONS', `/commands/${id}`], ['DELETE', `/commands/${id}`],
    ['POST', '/commands/connectivity'], ['GET', '/commands'], ['GET', `/commands/${id}/`],
    ['POST', `/commands/${id}/cancel`], ['GET', `/commands/${id}/receipt/extra`],
    ['GET', '/commands/' + '-'.repeat(36)], ['GET', '/commands/%30' + id.slice(1)],
    ['POST', '/ingest'], ['POST', '/today'], ['POST', '/foods-seen'], ['GET', '/pending-all'],
    ['POST', '/sync-ack'], ['POST', '/upload-export'], ['POST', '/oauth/gmail/start'],
    ['POST', '/mcp'], ['GET', '/health'], ['GET', '/commands/future-operation'],
  ])('rejects out-of-scope %s %s even with a valid credential', async (method, path) => {
    expect(phoneCommandRouteAllowed(request(path, method))).toBe(false);
    expect(await authorizePhoneCommandRequest(request(path, method), env)).toBe(false);
  });
  it.each([undefined, '', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), ` ${digest}`, digest+'\n'])
    ('fails closed with a missing or malformed digest (%s)', async configured => {
      env.PHONE_COMMAND_TOKEN_SHA256 = configured;
      expect(await authorizePhoneCommandRequest(request(), env)).toBe(false);
    });
  it.each(['', 'B'.repeat(43), 'A'.repeat(42), 'A'.repeat(44), '+'.repeat(43), 'A'.repeat(10000)])
    ('rejects absent, wrong, or malformed phone input (%s)', async input => {
      expect(await authorizePhoneCommandRequest(request(undefined, undefined, {'x-phone-command-token':input}), env)).toBe(false);
    });
  it('does not accept phone credentials in query strings, legacy headers, Authorization, or bodies', async () => {
    for (const req of [request(undefined,undefined,{}), request(`/commands/${id}?token=${token}`,'GET',{}),
      request(undefined,undefined,{'x-ingest-secret':token}), request(undefined,undefined,{Authorization:`Bearer ${token}`}),
      new Request(`https://test/commands/${id}/receipt`,{method:'POST',body:JSON.stringify({token,secret:token})})]) {
      expect(await authorizePhoneCommandRequest(req,env)).toBe(false);
    }
  });
  it('keeps legacy authorization independent of phone provisioning', async () => {
    for (const configured of [undefined, '', 'broken', digest]) {
      env.PHONE_COMMAND_TOKEN_SHA256 = configured;
      for (const [method,path] of paths) {
        expect(await authorizePhoneCommandRequest(request(path,method,{'x-ingest-secret':env.INGEST_SECRET}),env)).toBe(true);
      }
    }
    delete env.INGEST_SECRET;
    expect(await authorizePhoneCommandRequest(request(undefined,undefined,{}),env)).toBe(false);
    expect(await authorizePhoneCommandRequest(request(),env)).toBe(true);
  });
  it('fails closed if hashing fails, without logging a token or upstream error', async () => {
    vi.spyOn(crypto.subtle,'digest').mockRejectedValue(new Error(token));
    const warn=vi.spyOn(console,'warn'); const log=vi.spyOn(console,'log'); const error=vi.spyOn(console,'error');
    expect(await authorizePhoneCommandRequest(request(),env)).toBe(false);
    expect(warn).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
  it('rotates or revokes the digest without a grace period or fallback', async () => {
    env.PHONE_COMMAND_TOKEN_SHA256 = createHash('sha256').update('B'.repeat(43)).digest('hex');
    expect(await authorizePhoneCommandRequest(request(),env)).toBe(false);
    expect(await authorizePhoneCommandRequest(request(undefined,undefined,{'x-phone-command-token':'B'.repeat(43)}),env)).toBe(true);
    delete env.PHONE_COMMAND_TOKEN_SHA256;
    expect(await authorizePhoneCommandRequest(request(),env)).toBe(false);
  });
});

describe('safe phone connectivity and rejection paths', () => {
  it.each(['email','pushcut',undefined])('checks authentication without touching DB, fetch, or command state (mode %s)', async mode => {
    env.FOOD_DELIVERY_MODE = mode;
    const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('no network'));
    const response=await handleCommand(request('/commands/connectivity'),env);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ok:true,scope:'email_commands',email_delivery_enabled:mode==='email'});
    expect(env.DB.prepare).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated connectivity and wrong methods without side effects', async () => {
    expect((await handleCommand(request('/commands/connectivity','GET',{}),env)).status).toBe(401);
    expect((await handleCommand(request('/commands/connectivity','POST'),env)).status).toBe(405);
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
  it('does not touch DB for unauthorized, malformed, or wrong-method command requests', async () => {
    for(const [method,path] of paths.slice(0,3)) expect((await handleCommand(request(path,method,{}),env)).status).toBe(401);
    expect((await handleCommand(request(`/commands/${id}/start`),env)).status).toBe(405);
    expect((await handleCommand(request('/commands/'+'-'.repeat(36)),env)).status).toBe(404);
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
  it('cannot enable command operations when email delivery is disabled', async () => {
    env.FOOD_DELIVERY_MODE='pushcut';
    for(const [method,path] of paths.slice(0,3)) expect((await handleCommand(request(path,method),env)).status).toBe(404);
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
});
