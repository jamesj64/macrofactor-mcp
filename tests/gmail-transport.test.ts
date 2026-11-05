import { expect, it, vi } from 'vitest';
import { sendWake } from '../src/gmail-transport';
const env = { GMAIL_CLIENT_ID: 'test', GMAIL_CLIENT_SECRET: 'test', GMAIL_REFRESH_TOKEN: 'test', GMAIL_SENDER: 'sender@example.com', GMAIL_RECIPIENT: 'recipient@example.com' };
it('uses Workers-supported manual redirects for token refresh and Gmail send', async () => {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.redirect).toBe('manual');
    return Response.json(url.includes('/token') ? { access_token: 'test-access' } : { id: 'test-mail' });
  });
  expect(await sendWake(env, 'command1', 'attempt1', fetcher as any)).toEqual({ messageId: 'test-mail' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([301, 302, 303, 307, 308])('rejects token refresh redirects without following (%s)', async status => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.redirect).toBe('manual');
    return new Response(null, { status, headers: { Location: 'https://untrusted.example/' } });
  });
  await expect(sendWake(env, 'command1', 'attempt1', fetcher as any)).rejects.toThrow(`HTTP ${status}`);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
