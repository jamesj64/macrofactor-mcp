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

The private email-command Shortcut can use `x-phone-command-token` for the four operations below.
Existing `x-ingest-secret` command clients remain supported. No credentials in query strings or
shared shortcuts. Legacy `/today`, refresh, export and queue routes still require their existing
ingest credential; the new phone credential does not authorize them.

- GET `/commands/connectivity` -> `{ok:true,scope:"email_commands",email_delivery_enabled:boolean}`.
  Authenticated, uncached and read-only: it does not access the DB, queues, Gmail or MacroFactor.
  It works before email mode is enabled. It proves credential/Worker reachability only, not Gmail
  delivery, database readiness, Shortcut execution or MacroFactor app persistence.
- GET `/commands/{id}` -> `id,state,mode,food,food_json,expected_name,expires_at`.
  `food_json` is JSON text containing a **one-element array** for the inspected Log by JSON Shortcut.
  `food` is the single object. Modes: ready -> execute; started/uncertain -> verify; other -> stop.
- POST `/commands/{id}/start` -> `execute` Boolean and `decision` string, execute or stop.
- POST `/commands/{id}/receipt` body:
  `{status:"confirmed",observed:{name,nutrients:{energy,protein,carbs,fat}},summary?:object}`.
  Exact marker name and matching observed macros are required. Mismatch holds the command.
  Alternatively `{status:"uncertain"}` records ambiguity. Duplicate confirmation is safe.
  The existing optional summary can update daily totals and snapshots after confirmation. The phone
  credential is endpoint-scoped, not restricted to command-state-only writes.
- POST `/today` separately can upload a fresh MacroFactor summary; it cannot undo the receipt.
  This separate endpoint still requires the existing ingest credential.

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

1. Apply `0003_email_commands.sql`, `0004_gmail_oauth.sql`, and `0005_gmail_setup_codes.sql` only after deployment authorization.
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

## Scoped email-command phone credential

Provisioning is a separate authorized production operation, not part of deploying this code. There
is no credential-generation, enrollment or public issuance endpoint. Without
`PHONE_COMMAND_TOKEN_SHA256`, the new phone credential path is disabled and legacy clients keep
working. No schema migration, new Cloudflare service, OAuth grant or legacy-secret rotation is needed.

When separately authorized, generate a distinct 32-byte cryptographically random credential in a
secure setup flow and encode it as unpadded base64url (43 characters). Never reuse `INGEST_SECRET`,
MCP, Gmail or setup credentials. Hash the exact encoded credential as UTF-8 with SHA-256, with no
trailing newline, and configure only its 64-character lowercase hexadecimal digest as the Worker
secret `PHONE_COMMAND_TOKEN_SHA256`. Keep the plaintext only in the private phone Shortcut's
`x-phone-command-token` header. Do not put it in repository files, Wrangler vars, shared Shortcuts,
email, URLs, logs, telemetry or build output. Do not enable request-header logging.

The fixed HTTPS Worker origin must be used directly. The new header authorizes only:

- GET `/commands/connectivity`.
- GET `/commands/{uuid}`.
- POST `/commands/{uuid}/start`.
- POST `/commands/{uuid}/receipt` (including the existing optional summary behavior).

It cannot create/list/cancel commands, send mail, authorize Gmail OAuth, access the MCP API or
authorize `/ingest`, `/today`, `/foods-seen`, legacy queues or exports. It still requires email
delivery mode for the three command operations, and it does not bypass one-shot start or receipt
validation. Connectivity remains usable with email delivery disabled, without any food or mail test.
Malformed/missing configuration, unsupported methods and unlisted routes fail closed. The server
never returns the credential or digest and has no plaintext-credential storage. The credential is
long-lived until revoked or rotated, and possession allows reading command food data and exercising
the listed operations for known command IDs. Treat it as a bearer secret even though it is scoped.

Production rollout, only after the corresponding approvals:

1. Deploy the code while preserving all existing production variables, secrets, bindings and public
   pages. Do not copy the repository's disabled bootstrap flags over a configured live environment.
2. Provision the digest and configure the private Shortcut through the authorized secure flow.
3. Call only GET `/commands/connectivity` to verify reachability and credential matching. A successful
   response is not a live food, Gmail, DB or end-to-end phone test.

To revoke, remove `PHONE_COMMAND_TOKEN_SHA256`. To rotate, replace it with the new digest and update
the private Shortcut together; the previous credential stops working immediately and no grace
period is retained. Legacy `INGEST_SECRET` clients are unaffected. Removing this code also disables
the new credential; do not broaden legacy authorization as a rollback shortcut.

## One-use Gmail setup credential

The browser setup form accepts a separate setup credential, never the long-lived ingest key.
An authorized administrator generates 32 random bytes using Web Crypto in secure browser memory,
encodes them as unpadded base64url (43 characters), and computes SHA-256 over that encoded string.
Insert only the unpadded base64url hash into `gmail_oauth_setup_codes`, with `issued_at` set to current
Unix milliseconds and `expires_at` set to `issued_at + 600000`. Never insert the plaintext credential,
print it, put it in a URL, or save it to files, clipboard, logs, or browser storage. Fill the password
field directly from browser memory and discard the value after submission.

POST `/oauth/gmail/start` accepts this credential in `x-gmail-setup-code` and consumes its hash using
one atomic DELETE RETURNING before creating OAuth state. Reuse, expiry, future issuance, malformed
credentials and cross-origin browser requests fail closed. A failed start after consumption needs a
new credential. The existing `x-ingest-secret` path remains compatible and other ingest routes are
unchanged; setup credentials authorize only the OAuth start route. OAuth still requires PKCE,
same-browser state binding and the configured Google sender check. Provisioning is administrative:
there is no public credential issuance endpoint. This change does not activate food delivery or send mail.
