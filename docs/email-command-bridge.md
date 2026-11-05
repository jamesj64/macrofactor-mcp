# Per-entry email command bridge

Implementation is feature-gated: `FOOD_DELIVERY_MODE=pushcut` preserves existing phone/queue behavior.
Switching to `email` disables legacy queue consumption and uses individually addressed commands.
No food, mail, credential or production database tests were performed during development.

## Flow

1. Existing food tools accept `request_id`. In email mode it is mandatory: generate one per intended
   meal and reuse it on tool retries. A changed payload or item list under the same key is rejected.
2. Each actual entry receives one UUID, immutable validated payload, and `[MF:UUID]` name marker.
   Retrying sends the same command; a new intentional serving strips old markers and gets a new UUID.
3. A minute cron sends due Gmail wakes. Body: `MF_COMMAND_ID=<UUID>`. Default retry interval is ten
   minutes; configurable. No food data or authentication secret is placed in the email.
4. The phone fetches that exact command and searches MacroFactor's returned Recent Food list for
   the exact expected name. If present with matching macros, it sends a receipt, never logs again.
5. A new execution requires atomic `/start` permission. Only `decision=execute` / `execute=true`
   permits Log by JSON. A lost response or unknown app result never reauthorizes execution.
6. Confirmed receipts stop wakes. Started/uncertain commands receive verification-only wakes.
7. Each email is independently moved to Gmail Trash after its configured lifetime, even without a
   food receipt. Minute scheduling means approximately one to two minutes for a 60-second lifetime.

## Phone HTTP contract

All routes use `x-ingest-secret` in the header. No credentials in query strings or shared shortcuts.

- GET `/commands/{id}` -> `id,state,mode,food,food_json,expected_name,expires_at`.
  `food_json` is JSON text containing a **one-element array** for the inspected Log by JSON Shortcut.
  `food` is the single object. Modes: ready -> execute; started/uncertain -> verify; other -> stop.
- POST `/commands/{id}/start` -> `execute` Boolean and `decision` string, execute or stop.
- POST `/commands/{id}/receipt` body:
  `{status:"confirmed",observed:{name,nutrients:{energy,protein,carbs,fat}},summary?:object}`.
  Exact marker name and matching observed macros are required. Mismatch holds the command.
  Alternatively `{status:"uncertain"}` records ambiguity. Duplicate confirmation is safe.
- POST `/today` separately can upload a fresh MacroFactor summary; it cannot undo the receipt.

A receipt is a phone assertion based on a fresh lookup, not a native MacroFactor transaction ID.
Recent Food is not a complete per-consumption ledger; nonmatch on an uncertain command never
means permission to log again. This integration cannot delete or edit an existing MacroFactor entry.
`cancel_pending_log(command_id)` cancels future execution/wakes; an already running action can land.

## Safety and validation

Final per-serving values must include kcal, protein, carbs and fat. Invalid/implausible values,
large meal totals, calorie/macro mismatch, oversized serving amounts and inconsistent recipe
components are held before any mail/app execution. Default review cap is 3000 kcal, configurable;
this is an error-checking threshold, not dietary advice. A 15000-kcal ordinary entry is held.
Correct the source portion/units and create a new request ID rather than mutating a dispatched item.
Ready entries expire across local-day rollover (USER_TZ). Started entries remain verification-only.
The server never blindly resets started/uncertain work. No automatic negative-calorie correction.

## Gmail and authorization

Worker configuration/secrets:
- GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET (Google web OAuth client).
- GMAIL_SENDER and GMAIL_RECIPIENT, explicit bare addresses.
- GMAIL_REDIRECT_URI, exact HTTPS Worker origin + `/oauth/gmail/callback`.
- GMAIL_TOKEN_ENCRYPTION_KEY, random base64-encoded 32-byte secret, stored only as Worker secret.
- GMAIL_OAUTH_ENABLED=true only for authorized bootstrap; independent of food delivery mode.
- Optional externally provisioned GMAIL_REFRESH_TOKEN instead of encrypted-store bootstrap.

OAuth uses gmail.modify (send + recoverable trash + exact reconciliation), PKCE, ten-minute single-use
state, same-browser secure HttpOnly cookie, pinned redirect and verified Google account. Refresh token
is AES-GCM encrypted in D1; no credentials/codes appear in responses or application logs. Disable
upstream invocation/request URL logging before real callbacks; Cloudflare config does so here.

Gmail sends return IDs in the sender account. Cleaning that ID removes the sender's copy only;
different-account recipient cleanup requires separate authorized account access and is not implemented.
Self-send copy/trigger behavior must be checked on the actual chosen account. No subject-wide/thread
bulk deletion. Cleanup verifies sender, SENT label and transport marker on the exact message.
An uncertain send is reconciled by deterministic RFC Message-ID and exact headers; if no safe match
is found, cleanup backs off rather than deleting unrelated mail. Later wakes retain the food ID.

## Activation / rollback

1. Apply `0003_email_commands.sql` and `0004_gmail_oauth.sql` only after deployment authorization.
   Never run remote destructive initialization or copy claimed legacy entries into new commands.
2. Configure the explicitly approved Gmail accounts/client and encryption secret through secure
   tooling. Complete OAuth in the same browser via the setup/start route and exact callback.
3. Install the new private Shortcut and create the email trigger. Configure its credential privately.
   Rotate the previously shared credential in coordination with all installed read/export shortcuts.
4. Reconcile/cancel old pending queues, then set FOOD_DELIVERY_MODE=email. New email commands refuse
   creation while old queues are nonempty. Water/weight logging tools stay disabled in email mode.
5. Validate email trigger and cleanup using an explicitly authorized no-food test first; no live food
   write is needed merely to test delivery. Do not assert actual device behavior from unit tests.
6. Rollback pauses email dispatch by returning to pushcut mode. Reconcile started/uncertain commands
   before any manual re-log; never copy them automatically into v1. Outstanding email cleanup is paused
   with the bridge, so run explicit cleanup or re-enable the scheduler after fixing configuration.

Existing MF Refresh/MF Nightly and optional export uploader remain read-side inputs. No new Cloudflare
service is required; existing Worker, D1 and cron are sufficient. Stored-command schema is deliberately
separate from legacy queue tables. Gmail connection grants, secrets, deployments and actual test emails
must use the authorized setup flow, not inferred authorization from a code test.

## Verification

`npm run type-check`; `npm test`; `npx wrangler deploy --dry-run` (no deployment).
Critical local tests exercise immutable retries, one-shot start, uncertain results, validation,
receipt matching, stale day, independent cleanup, lost-send reconciliation and legacy-mode gates.
Mocks/SQLite do not prove actual Mail timing, app persistence or production D1 concurrency.
