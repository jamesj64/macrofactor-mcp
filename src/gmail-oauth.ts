/** Explicit administrator-initiated OAuth bootstrap; never returns credentials. */
export interface GmailOAuthEnv {
  DB?: D1Database;
  INGEST_SECRET?: string;
  GMAIL_OAUTH_ENABLED?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_SENDER?: string;
  GMAIL_REDIRECT_URI?: string;
  GMAIL_TOKEN_ENCRYPTION_KEY?: string;
}

const COOKIE = '__Host-mf-gmail-oauth';
const TTL_MS = 10 * 60_000;
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const encoder = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
const url64 = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unb64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), char => char.charCodeAt(0));
}
const random = () => url64(crypto.getRandomValues(new Uint8Array(32)));
const digest = async (text: string) => url64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));

async function encryptionKey(env: GmailOAuthEnv): Promise<CryptoKey> {
  try {
    const bytes = unb64(env.GMAIL_TOKEN_ENCRYPTION_KEY ?? '');
    if (bytes.length !== 32) throw new Error();
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch { throw new Error('Gmail encrypted storage is not configured'); }
}
function aad(env: GmailOAuthEnv, purpose: string): Uint8Array {
  return encoder.encode(JSON.stringify(['mf-gmail-v1', purpose, env.GMAIL_CLIENT_ID, env.GMAIL_SENDER?.toLowerCase()]));
}
async function encrypt(env: GmailOAuthEnv, plaintext: string, purpose: string) {
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(env, purpose) }, key, encoder.encode(plaintext));
  return { ciphertext: b64(new Uint8Array(ciphertext)), iv: b64(iv) };
}
async function decrypt(env: GmailOAuthEnv, ciphertext: string, iv: string, purpose: string) {
  try {
    const key = await encryptionKey(env);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: aad(env, purpose) }, key, unb64(ciphertext));
    return new TextDecoder().decode(plaintext);
  } catch { throw new Error('Gmail encrypted credential could not be read'); }
}

/** True means storage is configured, not that authorization has been completed. */
export function gmailTokenStoreConfigured(env: GmailOAuthEnv): boolean {
  try { return !!env.DB && unb64(env.GMAIL_TOKEN_ENCRYPTION_KEY ?? '').length === 32; } catch { return false; }
}

export async function readStoredGmailRefreshToken(env: GmailOAuthEnv): Promise<string> {
  if (!env.DB || !env.GMAIL_SENDER) throw new Error('Gmail encrypted storage is not configured');
  let row: { sender: string; ciphertext: string; iv: string } | null;
  try {
    row = await env.DB.prepare("SELECT sender,ciphertext,iv FROM gmail_oauth_tokens WHERE id='primary'")
      .first<{sender:string;ciphertext:string;iv:string}>();
  } catch { throw new Error('Gmail encrypted credential is unavailable'); }
  if (!row || row.sender.toLowerCase() !== env.GMAIL_SENDER.toLowerCase()) throw new Error('Gmail authorization is not ready for the configured sender');
  const token = await decrypt(env, row.ciphertext, row.iv, 'refresh-token');
  if (!token || /[\r\n]/.test(token)) throw new Error('Invalid stored Gmail credential');
  return token;
}

function configured(env: GmailOAuthEnv, request: Request): URL {
  if (!env.DB || !env.INGEST_SECRET || !env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_SENDER
    || !/^[^\s<>@]+@[^\s<>@]+$/.test(env.GMAIL_SENDER) || !gmailTokenStoreConfigured(env)) throw new Error('OAuth configuration incomplete');
  const redirect = new URL(env.GMAIL_REDIRECT_URI ?? '');
  if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.search || redirect.hash
    || redirect.pathname !== '/oauth/gmail/callback' || new URL(request.url).origin !== redirect.origin) throw new Error('Invalid pinned OAuth origin');
  return redirect;
}

const responseHeaders = {
  'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff',
};
function result(body: unknown, status: number, cookie?: string): Response {
  const headers = new Headers({ ...responseHeaders, 'Content-Type': 'application/json; charset=utf-8' });
  if (cookie) headers.set('Set-Cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}
const cookieValue = (value: string, maxAge = 600) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
function browserCookie(request: Request): string | undefined {
  const matches = (request.headers.get('Cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

// Only fixed, allowlisted diagnostics may reach logs. Never log upstream bodies,
// exception messages, URLs, request headers, or credential values.
const GOOGLE_ERROR_CODES = new Set(['invalid_client', 'invalid_grant', 'invalid_request',
  'unauthorized_client', 'unsupported_grant_type', 'access_denied', 'invalid_scope',
  'SERVICE_DISABLED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'API_KEY_SERVICE_BLOCKED']);
class GmailOAuthRequestError extends Error {
  constructor(readonly reason: 'network' | 'http' | 'invalid_json', readonly status?: number, readonly upstreamCode?: string) {
    super('Gmail authorization request failed');
  }
}
async function getJSON(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  } catch { throw new GmailOAuthRequestError('network'); }
  if (!response.ok) {
    let upstreamCode: string | undefined;
    try {
      const body: any = await response.json();
      const candidates = [body?.error, ...(Array.isArray(body?.error?.details) ? body.error.details.map((detail: any) => detail?.reason) : [])];
      upstreamCode = candidates.find(value => typeof value === 'string' && GOOGLE_ERROR_CODES.has(value));
    } catch { /* An unreadable upstream body must not prevent safe diagnostics. */ }
    throw new GmailOAuthRequestError('http', response.status, upstreamCode);
  }
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new GmailOAuthRequestError('invalid_json'); }
}

export async function handleGmailOAuth(request: Request, env: GmailOAuthEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  if (env.GMAIL_OAUTH_ENABLED !== 'true') return result({ error: 'not_found' }, 404);
  const url = new URL(request.url);
  if (!['/oauth/gmail/setup', '/oauth/gmail/start', '/oauth/gmail/callback'].includes(url.pathname)) return result({ error: 'not_found' }, 404);
  let redirect: URL;
  try { redirect = configured(env, request); } catch { return result({ error: 'gmail_oauth_not_configured' }, 503); }
  if (url.pathname === '/oauth/gmail/setup') {
    if (request.method !== 'GET') return result({ error: 'GET only' }, 405);
    if (url.search) return result({ error: 'query_parameters_not_allowed' }, 400);
    const nonce = random();
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Gmail</title></head>
<body><main><h1>Connect Gmail</h1><p>Enter your single-use Gmail setup code, then continue to Google in this browser.</p>
<p>Google will request Gmail read, send, and modify access. The bridge uses this to send wake emails and move its own sent wake copies to Trash.</p>
<form id="connect" method="post" action="/oauth/gmail/setup" autocomplete="off"><label for="key">Gmail setup code</label>
<input id="key" type="password" required autocomplete="off" autocapitalize="none" spellcheck="false"><button id="submit" type="submit">Continue to Google</button></form>
<p id="status" role="status" aria-live="polite"></p></main>
<script nonce="${nonce}">
const form = document.getElementById('connect');
const input = document.getElementById('key');
const button = document.getElementById('submit');
const status = document.getElementById('status');
form.addEventListener('submit', async event => {
  event.preventDefault();
  let key = input.value;
  input.value = '';
  button.disabled = true;
  status.textContent = 'Starting secure connection…';
  try {
    const pending = fetch('/oauth/gmail/start', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'x-gmail-setup-code': key } });
    key = '';
    const response = await pending;
    if (!response.ok) throw new Error('start failed');
    const data = await response.json();
    const target = new URL(data.authorization_url);
    if (target.origin !== 'https://accounts.google.com' || target.pathname !== '/o/oauth2/v2/auth') throw new Error('invalid destination');
    location.assign(target.href);
  } catch {
    status.textContent = 'Could not start. Check the setup code and bridge configuration, then try again.';
    button.disabled = false;
  } finally { key = ''; input.value = ''; }
});
</script></body></html>`, { headers: { ...responseHeaders, 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    } });
  }
  if (url.pathname === '/oauth/gmail/start') {
    if (request.method !== 'POST') return result({ error: 'POST only' }, 405);
    // No query-string credentials and no cross-origin browser bootstrap.
    if (url.search || (request.headers.has('Origin') && request.headers.get('Origin') !== redirect.origin)) return result({ error: 'invalid_start_origin' }, 403);
    try {
      // Existing ingest-key clients remain compatible. Setup codes authorize only this route.
      if (request.headers.get('x-ingest-secret') !== env.INGEST_SECRET) {
        const code = request.headers.get('x-gmail-setup-code') ?? '';
        if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return result({ error: 'unauthorized' }, 401);
        const now = Date.now();
        // Atomic consumption prevents concurrent starts and replay. A failed start needs a new code.
        const grant = await env.DB!.prepare(`DELETE FROM gmail_oauth_setup_codes
          WHERE code_hash=? AND issued_at<=? AND expires_at>?
          AND expires_at-issued_at<=? RETURNING code_hash`)
          .bind(await digest(code), now, now, TTL_MS).first();
        if (!grant) return result({ error: 'unauthorized' }, 401);
      }
      const state = random();
      const binding = random();
      const verifier = random();
      const stateHash = await digest(state);
      const stored = await encrypt(env, verifier, `pkce:${stateHash}`);
      const now = Date.now();
      await env.DB!.batch([
        env.DB!.prepare('DELETE FROM gmail_oauth_states WHERE expires_at<=?').bind(now),
        env.DB!.prepare('INSERT INTO gmail_oauth_states (state_hash,browser_hash,ciphertext,iv,expires_at) VALUES (?,?,?,?,?)')
          .bind(stateHash, await digest(binding), stored.ciphertext, stored.iv, now + TTL_MS),
      ]);
      const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authorization.search = new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID!, redirect_uri: redirect.href,
        response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent',
        state, code_challenge: await digest(verifier), code_challenge_method: 'S256',
        login_hint: env.GMAIL_SENDER!, include_granted_scopes: 'false' }).toString();
      return result({ authorization_url: authorization.href, expires_in: TTL_MS / 1000 }, 200, cookieValue(binding));
    } catch { return result({ error: 'gmail_oauth_start_failed' }, 503); }
  }
  if (request.method !== 'GET') return result({ error: 'GET only' }, 405);
  const state = url.searchParams.get('state');
  const binding = browserCookie(request);
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !binding
    || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length > 1) {
    return result({ error: 'invalid_or_expired_oauth_state' }, 400);
  }
  let stage = 'state_consume';
  try {
    const stateHash = await digest(state);
    // DELETE ... RETURNING consumes state atomically, before any token exchange.
    const pending = await env.DB!.prepare('DELETE FROM gmail_oauth_states WHERE state_hash=? AND browser_hash=? AND expires_at>? RETURNING ciphertext,iv')
      .bind(stateHash, await digest(binding), Date.now()).first<{ciphertext:string;iv:string}>();
    if (!pending) return result({ error: 'invalid_or_expired_oauth_state' }, 400, cookieValue('', 0));
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !code || code.length > 8192) return result({ error: 'gmail_authorization_not_completed' }, 400, cookieValue('', 0));
    stage = 'pkce_decrypt';
    const verifier = await decrypt(env, pending.ciphertext, pending.iv, `pkce:${stateHash}`);
    stage = 'token_exchange';
    const tokens = await getJSON(fetcher, 'https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID!, client_secret: env.GMAIL_CLIENT_SECRET!,
        redirect_uri: redirect.href, grant_type: 'authorization_code', code, code_verifier: verifier }).toString(),
    });
    stage = 'grant_validation';
    if (typeof tokens.access_token !== 'string' || !tokens.access_token || /[\r\n]/.test(tokens.access_token)
      || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token || /[\r\n]/.test(tokens.refresh_token)
      || typeof tokens.scope !== 'string' || !tokens.scope.split(' ').includes(SCOPE)) throw new Error('Incomplete Gmail grant');
    stage = 'profile_lookup';
    const profile = await getJSON(fetcher, 'https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (typeof profile.emailAddress !== 'string' || profile.emailAddress.toLowerCase() !== env.GMAIL_SENDER!.toLowerCase()) {
      return result({ error: 'gmail_sender_account_mismatch' }, 403, cookieValue('', 0));
    }
    stage = 'token_encrypt';
    const stored = await encrypt(env, tokens.refresh_token, 'refresh-token');
    stage = 'token_persist';
    await env.DB!.prepare(`INSERT INTO gmail_oauth_tokens (id,sender,ciphertext,iv,updated_at) VALUES ('primary',?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET sender=excluded.sender,ciphertext=excluded.ciphertext,iv=excluded.iv,updated_at=excluded.updated_at`)
      .bind(profile.emailAddress.toLowerCase(), stored.ciphertext, stored.iv, Date.now()).run();
    return result({ ok: true, message: 'Gmail is connected. You can close this tab.' }, 200, cookieValue('', 0));
  } catch (error) {
    console.warn(JSON.stringify({ event: 'gmail_oauth_callback_failed', stage,
      ...(error instanceof GmailOAuthRequestError ? { reason: error.reason, status: error.status, upstream_code: error.upstreamCode } : {}),
    }));
    return result({ error: 'gmail_oauth_callback_failed_restart_authorization' }, 400, cookieValue('', 0));
  }
}
