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
