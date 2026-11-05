import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleGmailOAuth, readStoredGmailRefreshToken } from '../src/gmail-oauth';

let sql: DatabaseSync;
let env: any;
class Stmt {
  values: any[] = [];
  constructor(public query: string) {}
  bind(...values: any[]) { this.values = values; return this; }
  allSync() { return { results: sql.prepare(this.query).all(...this.values) }; }
  async first() { return sql.prepare(this.query).get(...this.values) ?? null; }
  async run() { return sql.prepare(this.query).run(...this.values); }
}
beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0004_gmail_oauth.sql', import.meta.url), 'utf8'));
  sql.exec(readFileSync(new URL('../migrations/0005_gmail_setup_codes.sql', import.meta.url), 'utf8'));
  env = {
    DB: { prepare: (q: string) => new Stmt(q), batch: async (ss: Stmt[]) => {
      sql.exec('BEGIN'); try { const rows = ss.map(s => s.allSync()); sql.exec('COMMIT'); return rows; }
      catch (e) { sql.exec('ROLLBACK'); throw e; }
    } },
    INGEST_SECRET: 'test-only-ingest', GMAIL_OAUTH_ENABLED: 'true',
    GMAIL_CLIENT_ID: 'test-client', GMAIL_CLIENT_SECRET: 'test-only-secret',
    GMAIL_SENDER: 'sender@example.com', GMAIL_REDIRECT_URI: 'https://bridge.example/oauth/gmail/callback',
    GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); });
const google = (sender = 'sender@example.com') => vi.fn(async (url: string, init: RequestInit) => {
  expect(init.redirect).toBe('manual');
  if (url === 'https://oauth2.googleapis.com/token') {
    const body = new URLSearchParams(init.body as string);
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', scope: 'https://www.googleapis.com/auth/gmail.modify' });
  }
  expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile');
  return Response.json({ emailAddress: sender });
});
async function start() {
  const response = await handleGmailOAuth(new Request('https://bridge.example/oauth/gmail/start', {
    method: 'POST', headers: { 'x-ingest-secret': env.INGEST_SECRET, Origin: 'https://bridge.example' },
  }), env);
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax');
  const auth = new URL((await response.json() as any).authorization_url);
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  return { cookie: response.headers.get('set-cookie')!.split(';')[0], callback: `https://bridge.example/oauth/gmail/callback?state=${auth.searchParams.get('state')}&code=test-code` };
}
it('serves a nonce-restricted bootstrap without embedding credentials', async () => {
  const response = await handleGmailOAuth(new Request('https://bridge.example/oauth/gmail/setup'), env);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('type="password"');
  expect(html).not.toContain(env.INGEST_SECRET);
  expect(html).not.toContain('localStorage');
  const nonce = html.match(/<script nonce="([^"]+)"/)![1];
  expect(response.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`);
  expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
});
it('binds callback to its browser, stores only encrypted refresh token, and rejects replay', async () => {
  const { cookie, callback } = await start();
  const fetcher = google();
  expect((await handleGmailOAuth(new Request(callback, { headers: { Cookie: '__Host-mf-gmail-oauth=' + 'x'.repeat(43) } }), env, fetcher as any)).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
  const response = await handleGmailOAuth(new Request(callback, { headers: { Cookie: cookie } }), env, fetcher as any);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain('test-refresh');
  const stored = sql.prepare('SELECT * FROM gmail_oauth_tokens').get();
  expect(JSON.stringify(stored)).not.toContain('test-refresh');
  expect(await readStoredGmailRefreshToken(env)).toBe('test-refresh');
  expect((await handleGmailOAuth(new Request(callback, { headers: { Cookie: cookie } }), env, fetcher as any)).status).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await expect(readStoredGmailRefreshToken({ ...env, GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64') })).rejects.toThrow();
});
it('rejects a different Google account without saving its token', async () => {
  const { cookie, callback } = await start();
  expect((await handleGmailOAuth(new Request(callback, { headers: { Cookie: cookie } }), env, google('wrong@example.com') as any)).status).toBe(403);
  expect(sql.prepare('SELECT count(*) n FROM gmail_oauth_tokens').get()!.n).toBe(0);
});

async function provisionSetup(code: string, expires = Date.now() + 600_000) {
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))).toString('base64url');
  sql.prepare('INSERT INTO gmail_oauth_setup_codes VALUES (?,?,?)').run(hash, expires - 600_000, expires);
}
function setupRequest(code: string, origin = 'https://bridge.example') {
  return new Request('https://bridge.example/oauth/gmail/start', {
    method: 'POST', headers: { 'x-gmail-setup-code': code, Origin: origin },
  });
}
it('accepts a setup code only once under concurrent starts without the ingest key', async () => {
  const code = 'a'.repeat(43);
  await provisionSetup(code);
  const responses = await Promise.all([handleGmailOAuth(setupRequest(code), env), handleGmailOAuth(setupRequest(code), env)]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 401]);
  expect(sql.prepare('SELECT count(*) n FROM gmail_oauth_setup_codes').get()!.n).toBe(0);
});
it('rejects wrong, expired and overlong grants; cross-origin start does not consume code', async () => {
  const code = 'b'.repeat(43);
  await provisionSetup(code);
  expect((await handleGmailOAuth(setupRequest('c'.repeat(43)), env)).status).toBe(401);
  expect((await handleGmailOAuth(setupRequest(code, 'https://evil.example'), env)).status).toBe(403);
  expect(sql.prepare('SELECT count(*) n FROM gmail_oauth_setup_codes').get()!.n).toBe(1);
  sql.prepare('UPDATE gmail_oauth_setup_codes SET issued_at=?, expires_at=?').run(Date.now() - 600_001, Date.now() - 1);
  expect((await handleGmailOAuth(setupRequest(code), env)).status).toBe(401);
  expect(() => sql.prepare('UPDATE gmail_oauth_setup_codes SET expires_at=?').run(Date.now() + 3600_000)).toThrow();
  sql.prepare('UPDATE gmail_oauth_setup_codes SET issued_at=?, expires_at=?').run(Date.now() + 600_000, Date.now() + 900_000);
  expect((await handleGmailOAuth(setupRequest(code), env)).status).toBe(401);
});

it('rejects malformed credentials and query strings without consuming a valid code', async () => {
  const code = 'd'.repeat(43);
  await provisionSetup(code);
  for (const malformed of ['', 'short', 'x'.repeat(44), '!'.repeat(43)]) {
    expect((await handleGmailOAuth(setupRequest(malformed), env)).status).toBe(401);
  }
  const request = setupRequest(code);
  expect((await handleGmailOAuth(new Request(request.url + '?code=forbidden', request), env)).status).toBe(403);
  expect(sql.prepare('SELECT count(*) n FROM gmail_oauth_setup_codes').get()!.n).toBe(1);
});
it('consumes the setup code even if subsequent state storage fails', async () => {
  const code = 'e'.repeat(43);
  await provisionSetup(code);
  env.DB.batch = async () => { throw new Error('unavailable'); };
  expect((await handleGmailOAuth(setupRequest(code), env)).status).toBe(503);
  expect((await handleGmailOAuth(setupRequest(code), env)).status).toBe(401);
});
it('keeps legacy ingest authentication independent of the setup code table', async () => {
  sql.exec('DROP TABLE gmail_oauth_setup_codes');
  await start();
});

it.each([
  ['invalid_client', 'invalid_client'],
  ['secret-code-should-not-appear', undefined],
])('reports only allowlisted token exchange diagnostics (%s)', async (error, expected) => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { cookie, callback } = await start();
  const fetcher = vi.fn(async () => Response.json({ error, error_description: 'secret-description', access_token: 'secret-access' }, { status: 400 }));
  const response = await handleGmailOAuth(new Request(callback, { headers: { Cookie: cookie } }), env, fetcher as any);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'gmail_oauth_callback_failed_restart_authorization' });
  expect(warning).toHaveBeenCalledTimes(1);
  expect(JSON.parse(warning.mock.calls[0][0])).toEqual({ event: 'gmail_oauth_callback_failed', stage: 'token_exchange', reason: 'http', status: 400, ...(expected ? { upstream_code: expected } : {}) });
  expect(JSON.stringify(warning.mock.calls)).not.toMatch(/secret-|test-code|test-client|test-only|sender@example/);
  expect(sql.prepare('SELECT count(*) n FROM gmail_oauth_tokens').get()!.n).toBe(0);
  expect((await handleGmailOAuth(new Request(callback, { headers: { Cookie: cookie } }), env, fetcher as any)).status).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('distinguishes disabled Gmail API without logging upstream content', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { cookie, callback } = await start();
  const valid = google();
  const fetcher = vi.fn(async (url: string, init: RequestInit) => url.includes('/token') ? valid(url, init) : Response.json({ error: { message: 'private project information', details: [{ reason: 'SERVICE_DISABLED', metadata: { consumer: 'private-consumer' } }] } }, { status: 403 }));
  await handleGmailOAuth(new Request(callback, { headers: { Cookie: cookie } }), env, fetcher as any);
  expect(JSON.parse(warning.mock.calls[0][0])).toEqual({ event: 'gmail_oauth_callback_failed', stage: 'profile_lookup', reason: 'http', status: 403, upstream_code: 'SERVICE_DISABLED' });
  expect(JSON.stringify(warning.mock.calls)).not.toContain('private');
});
it.each(['network', 'invalid_json'])('safely identifies %s failures', async reason => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { cookie, callback } = await start();
  const fetcher = vi.fn(async () => { if (reason === 'network') throw new Error('secret exception'); return new Response('private malformed payload'); });
  await handleGmailOAuth(new Request(callback, { headers: { Cookie: cookie } }), env, fetcher as any);
  expect(JSON.parse(warning.mock.calls[0][0])).toEqual({ event: 'gmail_oauth_callback_failed', stage: 'token_exchange', reason });
});
it('identifies persistence failure without logging SQL or credential values', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { cookie, callback } = await start();
  const originalPrepare = env.DB.prepare;
  env.DB.prepare = (query: string) => { if (query.startsWith('INSERT INTO gmail_oauth_tokens')) throw new Error('private SQL failure'); return originalPrepare(query); };
  await handleGmailOAuth(new Request(callback, { headers: { Cookie: cookie } }), env, google() as any);
  expect(JSON.parse(warning.mock.calls[0][0])).toEqual({ event: 'gmail_oauth_callback_failed', stage: 'token_persist' });
});

it.each([301, 302, 303, 307, 308])('rejects token redirects without following or saving tokens (%s)', async status => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { cookie, callback } = await start();
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.redirect).toBe('manual');
    return new Response(null, { status, headers: { Location: 'https://untrusted.example/' } });
  });
  const response = await handleGmailOAuth(new Request(callback, { headers: { Cookie: cookie } }), env, fetcher as any);
  expect(response.status).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(sql.prepare('SELECT count(*) n FROM gmail_oauth_tokens').get()!.n).toBe(0);
});
