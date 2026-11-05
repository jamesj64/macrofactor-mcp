/** Gmail transport. Never creates credentials or accepts command-supplied recipients. */
import { gmailTokenStoreConfigured, readStoredGmailRefreshToken, type GmailOAuthEnv } from './gmail-oauth';
export type GmailEnv = GmailOAuthEnv & {
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  GMAIL_SENDER?: string;
  GMAIL_RECIPIENT?: string;
};

type Fetcher = typeof fetch;
type Config = { clientId: string; clientSecret: string; refreshToken?: string; sender: string; recipient: string; env: GmailEnv };
type Metadata = { id?: string; labelIds?: string[]; payload?: { headers?: { name: string; value: string }[] } };
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MESSAGE_PREFIX = 'mf-wake-';

function mailbox(value: string): string {
  // Configuration deliberately requires a bare address, not arbitrary MIME headers.
  if (!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error('Gmail configuration requires bare email addresses');
  }
  return value;
}

function config(env: GmailEnv): Config {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER, GMAIL_RECIPIENT } = env;
  if (![GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_SENDER, GMAIL_RECIPIENT].every(v => typeof v === 'string' && v.trim().length > 0)
    || (!GMAIL_REFRESH_TOKEN?.trim() && !gmailTokenStoreConfigured(env))) {
    throw new Error('Gmail transport is not configured');
  }
  return {
    clientId: GMAIL_CLIENT_ID!, clientSecret: GMAIL_CLIENT_SECRET!, refreshToken: GMAIL_REFRESH_TOKEN?.trim() || undefined, env,
    sender: mailbox(GMAIL_SENDER!), recipient: mailbox(GMAIL_RECIPIENT!),
  };
}

export function gmailConfigured(env: GmailEnv): boolean {
  try { config(env); return true; } catch { return false; }
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error('Invalid Gmail wake identifier');
  return value;
}

function messageId(attemptId: string): string {
  return `<${MESSAGE_PREFIX}${identifier(attemptId)}@macrofactor.invalid>`;
}

async function request(fetcher: Fetcher, url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    // Never forward credentials on redirects; Workers does not support redirect:'error'.
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(20_000), redirect: 'manual' });
  } catch {
    // Do not propagate upstream errors, URLs, tokens, or response bodies into logs.
    throw new Error('Gmail transport request failed; outcome may be uncertain');
  }
  if (!response.ok) throw new Error(`Gmail transport request failed (HTTP ${response.status})`);
  return response;
}

async function json<T>(response: Response): Promise<T> {
  try { return await response.json() as T; } catch { throw new Error('Invalid Gmail transport response'); }
}

async function accessToken(cfg: Config, fetcher: Fetcher): Promise<string> {
  const refreshToken = cfg.refreshToken ?? await readStoredGmailRefreshToken(cfg.env);
  const response = await request(fetcher, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret,
      refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
  });
  const value = await json<{ access_token?: unknown }>(response);
  if (typeof value.access_token !== 'string' || !value.access_token || /[\r\n]/.test(value.access_token)) {
    throw new Error('Invalid Gmail access token response');
  }
  return value.access_token;
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function validGmailId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
}

export async function sendWake(env: GmailEnv, commandId: string, attemptId: string, fetcher: Fetcher = fetch): Promise<{ messageId: string }> {
  const cfg = config(env);
  const command = identifier(commandId);
  const rfcId = messageId(attemptId);
  const token = await accessToken(cfg, fetcher);
  const mime = [
    `From: ${cfg.sender}`, `To: ${cfg.recipient}`, `Message-ID: ${rfcId}`,
    `Subject: MacroFactor command ${command}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 7bit', '',
    `MF_COMMAND_ID=${command}`, '',
  ].join('\r\n');
  const response = await request(fetcher, `${API}/messages/send`, {
    method: 'POST', headers: headers(token), body: JSON.stringify({ raw: base64url(mime) }),
  });
  const sent = await json<{ id?: unknown }>(response);
  if (!validGmailId(sent.id)) throw new Error('Gmail send returned no valid message ID; reconcile the attempt before retrying');
  return { messageId: sent.id };
}

async function metadata(id: string, token: string, fetcher: Fetcher): Promise<Metadata> {
  if (!validGmailId(id)) throw new Error('Invalid Gmail message ID');
  const query = new URLSearchParams({ format: 'metadata' });
  for (const name of ['Message-ID', 'From', 'Subject']) query.append('metadataHeaders', name);
  return json<Metadata>(await request(fetcher, `${API}/messages/${encodeURIComponent(id)}?${query}`, { headers: headers(token) }));
}

function header(meta: Metadata, name: string): string | undefined {
  const matches = meta.payload?.headers?.filter(h => h.name.toLowerCase() === name.toLowerCase());
  // Duplicated identity headers are ambiguous and must not authorize cleanup.
  return matches?.length === 1 ? matches[0].value.trim() : undefined;
}

function senderMatches(meta: Metadata, expected: string): boolean {
  const from = header(meta, 'From');
  if (!from || /[\r\n]/.test(from)) return false;
  const address = from.match(/^[^<>]*<([^<>]+)>$/)?.[1] ?? from;
  return address.toLowerCase() === expected.toLowerCase();
}

export async function findSentAttempt(env: GmailEnv, attemptId: string, fetcher: Fetcher = fetch): Promise<string[]> {
  const cfg = config(env);
  const expected = messageId(attemptId);
  const token = await accessToken(cfg, fetcher);
  const ids = new Set<string>();
  let pageToken: string | undefined;
  const seenPages = new Set<string>();
  do {
    const query = new URLSearchParams({ q: `in:sent rfc822msgid:${expected.slice(1, -1)}`, maxResults: '100' });
    if (pageToken) query.set('pageToken', pageToken);
    const page = await json<{ messages?: { id?: unknown }[]; nextPageToken?: string }>(
      await request(fetcher, `${API}/messages?${query}`, { headers: headers(token) }),
    );
    for (const candidate of page.messages ?? []) {
      if (!validGmailId(candidate.id)) continue;
      const meta = await metadata(candidate.id, token, fetcher);
      if (meta.labelIds?.includes('SENT') && header(meta, 'Message-ID') === expected && senderMatches(meta, cfg.sender)) ids.add(candidate.id);
    }
    pageToken = page.nextPageToken;
    if (pageToken) {
      if (seenPages.has(pageToken)) throw new Error('Gmail returned a repeated search page');
      seenPages.add(pageToken);
    }
  } while (pageToken);
  return [...ids];
}

export async function trashWake(env: GmailEnv, id: string, fetcher: Fetcher = fetch): Promise<void> {
  const cfg = config(env);
  const token = await accessToken(cfg, fetcher);
  const meta = await metadata(id, token, fetcher);
  const rfcId = header(meta, 'Message-ID') ?? '';
  const subject = header(meta, 'Subject') ?? '';
  if (!meta.labelIds?.includes('SENT') || !senderMatches(meta, cfg.sender)
    || !/^<mf-wake-[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}@macrofactor\.invalid>$/.test(rfcId)
    || !/^MacroFactor command [A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(subject)) {
    throw new Error('Refusing to trash a message that is not a verified sent wake');
  }
  // Message-level recoverable trash only. Never delete or alter a whole thread.
  if (meta.labelIds.includes('TRASH')) return;
  await request(fetcher, `${API}/messages/${encodeURIComponent(id)}/trash`, { method: 'POST', headers: headers(token) });
}
