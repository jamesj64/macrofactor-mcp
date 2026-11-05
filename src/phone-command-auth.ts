/** A separate, least-privilege credential for the private email-command Shortcut. */
export interface PhoneCommandAuthEnv {
  INGEST_SECRET?: string;
  // Lowercase hex SHA-256 of the 43-character base64url credential, never the credential itself.
  PHONE_COMMAND_TOKEN_SHA256?: string;
}

export const COMMAND_CONNECTIVITY_PATH = '/commands/connectivity';
const COMMAND_PATH = /^\/commands\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/(start|receipt))?$/;

/** Explicit method/path allowlist. New routes never inherit phone authorization. */
export function phoneCommandRouteAllowed(request: Request): boolean {
  const path = new URL(request.url).pathname;
  if (path === COMMAND_CONNECTIVITY_PATH) return request.method === 'GET';
  const match = COMMAND_PATH.exec(path);
  return !!match && request.method === (match[1] ? 'POST' : 'GET');
}

export async function authorizePhoneCommandRequest(request: Request, env: PhoneCommandAuthEnv): Promise<boolean> {
  if (!phoneCommandRouteAllowed(request)) return false;

  // Preserve the existing header-only command credential independently of phone provisioning.
  if (env.INGEST_SECRET && request.headers.get('x-ingest-secret') === env.INGEST_SECRET) return true;

  const token = request.headers.get('x-phone-command-token');
  const expected = env.PHONE_COMMAND_TOKEN_SHA256;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || !expected || !/^[0-9a-f]{64}$/.test(expected)) return false;

  try {
    const actual = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
    // Fixed-size comparison: never compare plaintext credentials or return a digest to the caller.
    let difference = 0;
    for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ parseInt(expected.slice(i * 2, i * 2 + 2), 16);
    return difference === 0;
  } catch {
    return false;
  }
}
