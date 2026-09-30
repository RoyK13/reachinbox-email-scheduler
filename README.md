# ReachInbox Email Scheduler

A full-stack email scheduling platform. You sign in with Google, upload a CSV/TXT lead list, compose an email, and schedule it. Every recipient becomes a **BullMQ delayed job** backed by **PostgreSQL** (the source of truth). A worker then sends it through a real **Ethereal SMTP** account, obeying a **distributed per-sender minimum delay and hourly limit** enforced atomically in **Redis (Lua)**. When a sender hits its hourly limit the remaining emails are **rescheduled, not dropped**, and a **real Slack message** is sent to the user's connected workspace. All emails are indexed in **Elasticsearch** for search, and the queue is observable live in **Bull Board**.

There is **no cron anywhere**: every future send is a BullMQ delayed job, and a one-time startup reconciliation repairs the queue from the database after restarts.

---

## Contents

- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Google OAuth setup](#google-oauth-setup)
- [Slack OAuth setup (and the rate-limit demo)](#slack-oauth-setup-and-the-rate-limit-demo)
- [Ethereal setup](#ethereal-setup)
- [How it works](#how-it-works)
  - [Scheduling & BullMQ](#scheduling--bullmq)
  - [Rate limiting (minimum delay + hourly limit)](#rate-limiting-minimum-delay--hourly-limit)
  - [Idempotency & duplicate-send protection](#idempotency--duplicate-send-protection)
  - [Restart behaviour](#restart-behaviour)
  - [1000+ emails at once](#1000-emails-at-once)
  - [Elasticsearch](#elasticsearch)
  - [Slack notifications](#slack-notifications)
  - [No cron](#no-cron)
- [API](#api)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Limitations & trade-offs (read this)](#limitations--trade-offs)

---

## Architecture

```text
React (Vite, Tailwind)                      Bull Board  (/api/admin/queues, auth-protected)
   │  HTTP-only session cookie                  │
   ▼                                            │
Express API ──────────────► PostgreSQL (Prisma)  ◄── source of truth
   │  POST /schedule            │
   │  1 tx: campaign + N emails │
   ▼                            │
BullMQ queue "email-send" (Redis, AOF-persisted) ── one delayed job per email, jobId = "email-<emailId>"
   │
   ▼
Worker (configurable concurrency)
   ├─ Redis Lua: reserve send slot (min delay + hourly limit, per tenant/sender)
   ├─ Postgres: atomic claim SCHEDULED → SENDING
   ├─ Nodemailer → Ethereal SMTP (the email's own sender account)
   ├─ Postgres: SENT (+ messageId, Ethereal preview URL)
   └─ Elasticsearch: upsert search document
```

| Concern | Where it lives |
| --- | --- |
| Email state (source of truth) | PostgreSQL |
| Delayed execution | BullMQ delayed jobs in Redis |
| Min delay + hourly limit | Redis, one atomic Lua script |
| Search / list views | Elasticsearch (`emails` index) |
| Rate-limit alert | Slack Web API (`conversations.open` + `chat.postMessage`) |
| Auth | Google OAuth 2.0 / OpenID Connect, Authorization Code + PKCE, Redis-backed sessions |
| Queue monitoring | Bull Board (Express adapter) |

The API (`src/server.ts`) and the worker (`src/worker.ts`) are **separate processes**. You can run several workers; all coordination goes through Redis and Postgres.

---

## Quick start

**Prerequisites:** Node.js ≥ 20 (tested with 24 LTS), Docker Desktop.

```bash
# 1. Infrastructure: PostgreSQL 17, Redis 7.4 (AOF), Elasticsearch 8.19, all with persistent volumes
docker compose up -d

# 2. Backend
cd backend
npm install
cp .env.example .env              # then fill in the values (see below)
npm run ethereal:create           # creates 2 Ethereal SMTP accounts; paste the printed line into .env
npx prisma migrate dev            # creates the schema (migrations are committed)
npm run prisma:seed               # creates the ES index; (re)provisions senders for existing users
npm run dev                       # API on :4000 + worker, with live reload

# 3. Frontend (new terminal)
cd frontend
npm install
cp .env.example .env
npm run dev                       # http://localhost:5173
```

Open http://localhost:5173 and click **Login with Google**.

Useful URLs:

- App: http://localhost:5173
- Health: http://localhost:4000/api/health
- Bull Board: http://localhost:4000/api/admin/queues (sign in first; also linked from the user menu as *Queue dashboard*)

Production-style run:

```bash
cd backend && npm run build && npm run start          # API
cd backend && npm run start:worker                    # worker (run 1..N of these)
cd frontend && npm run build && npm run preview
```

> **npm 11 note:** newer npm versions block dependency install scripts by default. `backend/package.json` and `frontend/package.json` already contain an `allowScripts` allow-list for the packages that need them (Prisma engines, esbuild, msgpackr). If your npm prints an `allow-scripts` warning, run `npm approve-scripts <pkg>` for the listed packages and then `npm rebuild`.

---

## Environment variables

### `backend/.env`

| Variable | Required | Example / default | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | | `development` | `production` enables secure cookies + trust proxy |
| `PORT` | | `4000` | API port |
| `FRONTEND_URL` | ✔ | `http://localhost:5173` | CORS origin + post-login redirects |
| `LOG_LEVEL` | | `info` | pino level |
| `DATABASE_URL` | ✔ | `postgresql://postgres:postgres@localhost:5432/reachinbox` | PostgreSQL |
| `REDIS_URL` | ✔ | `redis://localhost:6379` | BullMQ, rate limiter, sessions |
| `ELASTICSEARCH_URL` | ✔ | `http://localhost:9200` | Elasticsearch |
| `ELASTICSEARCH_INDEX` | | `emails` | Index name |
| `SESSION_SECRET` | ✔ | ≥ 16 random chars | Signs the session cookie |
| `TOKEN_ENCRYPTION_KEY` | ✔ | 32 bytes, base64 | AES-256-GCM encryption at rest for Slack tokens and SMTP passwords |
| `GOOGLE_CLIENT_ID` | ✔ | `…apps.googleusercontent.com` | Google OAuth |
| `GOOGLE_CLIENT_SECRET` | ✔ | | Google OAuth |
| `GOOGLE_CALLBACK_URL` | ✔ | `http://localhost:4000/api/auth/google/callback` | Must match the Google console exactly |
| `SLACK_CLIENT_ID` | ✔ | | Slack OAuth |
| `SLACK_CLIENT_SECRET` | ✔ | | Slack OAuth |
| `SLACK_REDIRECT_URI` | ✔ | `https://<tunnel>/api/slack/callback` | Must match the Slack app config |
| `WORKER_CONCURRENCY` | | `10` | BullMQ worker concurrency (per worker process) |
| `MIN_EMAIL_DELAY_MS` | | `2000` | **Floor** for the per-request delay between two sends from one sender |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | | `200` | **Ceiling** for the per-request hourly limit |
| `MAX_RECIPIENTS_PER_REQUEST` | | `10000` | Batch size cap |
| `SENDING_STALE_MS` | | `300000` | At worker start, `SENDING` rows older than this are marked FAILED (outcome unknown) |
| `QUEUE_NAME` | | `email-send` | BullMQ queue name |
| `BULL_BOARD_ENABLED` | | `true` | Mount Bull Board |
| `ETHEREAL_SENDERS_JSON` | ✔ | `[{"name":"Sender A","email":"…","user":"…","pass":"…"}]` | Sender accounts: array of `{name,email,user,pass[,host=smtp.ethereal.email,port=587,secure=false]}` |

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # TOKEN_ENCRYPTION_KEY
```

Configuration is validated with Zod at startup. A missing or invalid variable stops the process with a list of exactly what is wrong.

### `frontend/.env`

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | `http://localhost:4000` | Backend base URL (no trailing slash) |

No secrets ever go into the frontend.

---

## Google OAuth setup

1. Open <https://console.cloud.google.com/> → create or select a project.
2. **APIs & Services → OAuth consent screen**: choose *External*, fill in the app name and support email, and add scopes `openid`, `email`, `profile`. While the app is in *Testing*, add your Google account under **Test users**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorized JavaScript origins:** `http://localhost:5173`
   - **Authorized redirect URIs:** `http://localhost:4000/api/auth/google/callback` (exactly this; it must equal `GOOGLE_CALLBACK_URL`)
4. Copy the client ID and secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and restart the backend.

**Flow:** the frontend links to `GET /api/auth/google`. The backend stores a random `state` and a PKCE verifier in the session, then redirects to Google. Google calls `/api/auth/google/callback`, where the backend verifies the state, exchanges the code, and verifies the ID token signature and audience. It then upserts the user by `googleId`, regenerates the session (preventing fixation) and redirects to `/scheduled`.

The session is stored in Redis. The browser only holds the `rib.sid` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` in production).

---

## Slack OAuth setup (and the rate-limit demo)

1. Go to <https://api.slack.com/apps> → **Create New App → From scratch**, and pick your workspace.
2. **Slack requires `https` redirect URLs**, so expose the local backend through a tunnel, e.g.
   ```bash
   ngrok http 4000          # or: cloudflared tunnel --url http://localhost:4000
   ```
3. **OAuth & Permissions → Redirect URLs:** add `https://<your-tunnel-host>/api/slack/callback`, and put the same value in `SLACK_REDIRECT_URI`.
4. **OAuth & Permissions → Bot Token Scopes:** add `chat:write` and `im:write` (the minimum needed to open a DM with you and post into it).
5. **App Home:** enable the **Messages Tab**, so the bot's DMs are visible to you.
6. **Basic Information:** copy the **Client ID** and **Client Secret** into `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`, then restart the backend.
7. In the app, the sidebar card shows **Slack alerts → Connect Slack**. Click it and approve.
   - The OAuth `state` is stored in Redis (single use, 10 minutes), not in the cookie, so the callback works even though it arrives on the tunnel's domain.
   - After the callback you land back on `/scheduled?slack=connected`, see a toast, and the card switches to **Connected to <workspace>** with a **Disconnect** button.
8. **Verify:** `GET /api/slack/status` returns `{ connected: true, teamName: … }`. The token is never returned.

### Trigger a real rate-limit notification

1. Make sure the worker is running (`npm run dev` starts it).
2. Open **Compose** and add 5 recipients (type them, or upload a file).
3. Set **Hourly Limit = 2**, **Delay = 2 sec**, and click **Send**.
4. Within a few seconds, 2 emails are sent (open **Sent → Preview** to see them on Ethereal).
5. The 3rd email hits the limit. The worker logs `rate limit reached`, the remaining 3 emails move to the next hour window (visible in **Scheduled** and as *delayed* jobs in Bull Board), and **you receive a Slack DM from the app**:

   ```text
   ⚠️ ReachInbox rate limit reached.
   Sender: <sender>@ethereal.email
   Hourly limit: 2
   Current window: 2026-10-01 10:00–10:59 UTC
   Remaining scheduled emails: 3
   Emails will resume in the next available hour window (from 2026-10-01T11:00:00.000Z).
   ```

6. Only **one** message is sent per sender per hour window, no matter how many workers or jobs hit the limit. If Slack isn't connected, nothing is sent and email processing continues normally.

**Disconnect** calls `auth.revoke` (best effort) and deletes the stored connection. **Reconnect** upserts it. No restart is needed either way.

---

## Ethereal setup

[Ethereal](https://ethereal.email) is a fake SMTP service: messages are accepted but never delivered, and each one can be viewed on the web.

- **Automatic:** `cd backend && npm run ethereal:create` (or `npm run ethereal:create -- 3` for three) creates accounts through Nodemailer's API. It prints a ready-to-paste line:
  ```env
  ETHEREAL_SENDERS_JSON=[{"name":"ReachInbox Sender A","email":"xxx@ethereal.email","user":"xxx@ethereal.email","pass":"…","host":"smtp.ethereal.email","port":587,"secure":false}, …]
  ```
- **Manual:** click *Create Ethereal Account* on <https://ethereal.email/>. Repeat for each sender and write the JSON yourself.

**From address:**
- Every email is authored by the signed-in user: `From` and `Reply-To` are the user's Google name and email.
- The assigned Ethereal account is only the delivery transport: it's the `Sender` header and the SMTP envelope `MAIL FROM`.
- In Compose, **From** shows the user. **Send via** picks the Ethereal account(s): round-robin across all of them by default, or one specific account (sent as `senderIds`).
- With a real SMTP provider you'd need the user's domain to authorize the sending account (SPF/DKIM), or use a verified sending address.

**Sender configuration:**
- On login and on every API/worker startup, the configured senders are provisioned for each user (upsert by `(userId, email)`). Senders removed from the config are disabled.
- SMTP passwords are stored AES-GCM-encrypted and are never returned by any API.

**Verifying sends:**
- Every sent email stores `nodemailer.getTestMessageUrl(info)`. It appears as a small **Preview** link in the Sent list and on the email detail page.
- You can also log in to <https://ethereal.email/login> with a sender's credentials to see its whole mailbox.

---

## How it works

### Scheduling & BullMQ

`POST /api/emails/schedule` (full body under [API](#api)):

1. **Validation (Zod):**
   - Recipients are valid emails, trimmed, lowercased and **deduplicated in order**, 1–10,000 per request.
   - `startTime` is an ISO timestamp in the future. The frontend always sends UTC ISO strings built from the user's local time, and shows the time zone.
   - Delay and limit must be positive integers.
   - Settings are clamped to the server limits: `effectiveDelay = max(delay, MIN_EMAIL_DELAY_MS)` and `effectiveLimit = min(limit, MAX_EMAILS_PER_HOUR_PER_SENDER)`. Both are stored on the campaign and returned in the response.
2. **Sender assignment:** deterministic round-robin over the user's enabled senders (`sender[i % n]`), or over `senderIds` if given.
3. **`sequenceNumber = i`** preserves recipient order.
4. **Initial `scheduledAt` hint:** `start + floor(i / n) × delay`, where `n` is the number of senders. This is a hint; the Redis limiter decides the real send time, and the row is updated if it moves.
5. **One DB transaction:** the campaign row plus `createMany` of all email rows, in chunks of 1,000, with pre-generated UUIDs so there are no N+1 queries or read-backs.
6. **`queue.addBulk`** in chunks of 500: one delayed job per email.
   - `name: "send-email"`, `data: { emailId }`
   - `jobId: "email-<emailId>"`. The brief suggests `email:<id>`, but BullMQ 5 rejects `:` in custom IDs because it's the Redis key separator, so a hyphen is used.
   - `delay: scheduledAt − now`
7. **Elasticsearch bulk index.** Failures are logged and never fail the request.

**Job options:**
- `attempts: 3` with exponential backoff (30 s), used only for provably safe retries (see below).
- Completed jobs are kept 7 days (max 10k) and failed jobs 30 days, so Bull Board stays meaningful.

**Worker:** `new Worker('email-send', processor, { concurrency: WORKER_CONCURRENCY })`. No `setTimeout` per email, and no in-memory scheduler.

### Rate limiting (minimum delay + hourly limit)

Both rules are enforced by **one atomic Redis Lua script** (`src/lib/lua/reserve-send-slot.ts`), called by the worker right before sending:

```text
slot key:  email-slot:<senderId>                        → next free send time (epoch ms)
rate key:  email-rate:<userId>:<senderId>:<YYYY-MM-DDTHH> → reservations in that UTC hour
```

```text
t = max(now, GET slot)                                     # minimum delay between sends
h = hour(t)
while count(h) >= limit:  h = h + 1                        # hourly limit: find next window with capacity
if h moved:  t = start_of(h)
INCR count(h); PEXPIREAT count(h) end_of(h)+1h             # reserve (check + increment are atomic)
SET slot = t + delay
return ALLOWED (t ≈ now) | DELAYED (t in future) | RATE_LIMITED (window was full), slotAt = t
```

**Why it's safe:**
- Redis executes the script atomically.
- Any number of concurrent workers, processes or hosts get **distinct slots at least `delay` apart**.
- A window can **never exceed `limit`**, because the check and the increment happen together, so there's no check-then-increment race.
- No process-local state.

**Per sender, per tenant:**
- Senders belong to a user, so the slot key is effectively tenant+sender scoped.
- The counter key includes both user and sender, as required.
- Two senders send in parallel, each at its own pace.

**What the worker does with the answer:**

| Result | Action |
| --- | --- |
| `ALLOWED` | Send now (after ≤100 ms of alignment wait). |
| `DELAYED` | `job.updateData({ reservedSlotAt })`, then `job.moveToDelayed(slotAt)` and `throw new DelayedError()`. The job goes back to *delayed* without using an attempt and without sleeping. The DB `scheduledAt` and ES are updated. When it wakes, it uses the reservation it already holds and doesn't reserve twice. |
| `RATE_LIMITED` | Same as `DELAYED`, but `slotAt` is the **exact start of the next window with capacity**, so the job never fails and never gets dropped. The Slack alert is also fired (deduplicated). |

**Ordering:** initial `scheduledAt` hints are strictly increasing per sender in `sequenceNumber` order. BullMQ promotes delayed jobs in timestamp order, and the limiter hands out slots in arrival order. As a result, rate-limited jobs keep their relative order across windows (verified in `tests/integration/worker.test.ts`). This is "as much as reasonably possible", not a mathematical guarantee under arbitrary concurrency.

**Example:** 1000 emails, 1 sender, delay 2 s, limit 200/h, start 10:00.
- The first 200 get slots 10:00:00, 10:00:02, … and are sent over about 7 minutes.
- Job #201 gets `RATE_LIMITED`, is moved to 11:00:00, and one Slack alert goes out.
- Jobs #202+ get 11:00:02, 11:00:04, …; the next 200 fill 11:xx, and so on.
- The whole campaign completes over 5 hour windows.

### Idempotency & duplicate-send protection

**Duplicate schedule requests:**
- `idempotencyKey` is required.
- `campaigns` has `UNIQUE (userId, idempotencyKey)` and stores a SHA-256 of the normalized request.
- **Same key + same payload** → `200` with the original result (`idempotentReplay: true`). No new rows or jobs are created. The replay also re-enqueues any job a crashed first attempt failed to add, which is safe because job IDs are deterministic.
- **Same key + different payload** → `409 IDEMPOTENCY_CONFLICT`.
- **Concurrent identical requests:** the unique constraint picks one winner, and the others resolve to the replay path.
- Each email row also has a unique `idempotencyKey = <campaignId>:<sequenceNumber>`.
- The frontend generates one key per compose session, so double-clicks are harmless.

**Duplicate BullMQ deliveries:**
- Deterministic `jobId = email-<id>`: adding the same job twice is a no-op in BullMQ.
- The worker first re-reads the row; anything not `SCHEDULED` exits immediately.
- **Atomic claim:**
  ```sql
  UPDATE emails SET status='SENDING', "sendStartedAt"=now(), "attemptCount"=+1 WHERE id=$1 AND status='SCHEDULED'
  ```
  (`prisma.email.updateMany`). Only one worker can get `count = 1`; everyone else exits without sending.
- After SMTP accepts the message: `SENDING → SENT` with `sentAt`, `messageId` and `etherealPreviewUrl`.

**Retries:**
- **Pre-acceptance failures** (connection refused, DNS, auth, TLS, or a timeout during CONN/EHLO/AUTH/MAIL/RCPT, before `DATA`) are safe. The row goes back to `SCHEDULED` and BullMQ retries with backoff.
- **Anything else**, including a timeout during or after `DATA`, is **ambiguous**: the server may already have accepted the message. The row becomes `FAILED` with the error, and the job throws `UnrecoverableError`, so it is **never** retried.

### Restart behaviour

Scenario: 1000 future emails are scheduled, then everything is stopped and restarted.

1. **PostgreSQL** (Docker volume `pgdata`) keeps every email with its status and `scheduledAt`.
2. **Redis** (volume `redisdata`, `appendonly yes`, `appendfsync everysec`, `maxmemory-policy noeviction`) keeps the delayed jobs, rate-limit counters, send slots, Slack dedupe keys and sessions. After a normal restart the jobs are simply still there and fire at their times.
3. **Startup reconciliation** runs once when a worker boots (`src/services/reconciliation.service.ts`):
   - Page through `status = SCHEDULED` rows, 500 at a time, and look up each deterministic job ID.
   - **Live job** (delayed/waiting/active) → left untouched. Nothing is reset or duplicated.
   - **Missing job** (e.g. Redis data was lost) → re-added with `delay = scheduledAt − now`, the *stored* time. The campaign never restarts from the beginning.
   - **Finished job but the row is still `SCHEDULED`** → the stale entry is removed and re-added.
   - `SENT`/`FAILED` rows are never enqueued.
   - `SENDING` rows older than `SENDING_STALE_MS` become `FAILED` with *"Send outcome unknown … not retried to avoid duplicate delivery"*.
   - Running it twice changes nothing (tested).

The boot order is **Postgres → Redis → Elasticsearch (+ index) → sender sync → start worker → reconcile → ready**.

### 1000+ emails at once

- The API does **no sending**: validate, then one transaction (bulk inserts), then `addBulk` (chunks of 500), then ES bulk index, then return a summary. Scheduling 1000 recipients takes on the order of a second locally, including indexing (see the 1000-email case in `recovery.test.ts`).
- BullMQ holds 1000 delayed jobs. Workers pick them up up to `WORKER_CONCURRENCY` at a time per process.
- The Redis limiter spaces the actual sends and caps each hour. Excess jobs go back to *delayed* at their reserved slot; they're never busy-waiting or sleeping.
- Adding worker processes increases throughput only up to what the per-sender limits allow, which is the point.

### Attachments

- **Uploading:** the Compose paperclip (with a count badge, as in the Figma) uploads each file right away to `POST /api/attachments` (multipart, memory only). Uploads show as tiles under the editor: thumbnails for images, file cards otherwise, each with a ✕ to remove.
- **Storage:** files live in PostgreSQL (`attachments.data`), so every worker process on any host can read them without shared disk.
- **Limits:** 5 files, 5 MB each, 10 MB in total. Executable and script types are refused. All limits are enforced server-side and pre-checked in the browser.
- **Scheduling:** `attachmentIds` in the schedule request links the uploads to the campaign inside the same transaction. They're part of the idempotency hash, and an upload can belong to only one campaign.
- **Sending:** every email of the campaign is sent with the attachments through Nodemailer. The worker loads them *before* the atomic claim, so a DB error can't leave a row stuck in `SENDING`.
- **Viewing:** the email detail page lists the attachments as download links (`GET /api/attachments/:id`, user-scoped, always `Content-Disposition: attachment`).
- **Cleanup:** uploads never scheduled are deleted after 24 h, checked on each upload and once at worker startup. No timer.

### Elasticsearch

- **Index `emails`**, created at startup with explicit mappings (`dynamic: strict`):
  - IDs and `status`: `keyword`
  - `recipientEmail`: `keyword` with a lowercase normalizer, plus a `search_as_you_type` subfield
  - `subject`: `text` + `.keyword` + `.sayt`
  - All timestamps: `date`
- **Every write path updates ES after Postgres:** scheduling (bulk), every status change in the worker, rescheduling, and stale-SENDING recovery.
- **Search** (`GET /api/emails/scheduled|sent?q=&page=&pageSize=`):
  - `bool.filter` on the authenticated `userId` (from the session, never from the client) plus the tab's statuses.
  - The query is `bool_prefix` over the subject/recipient `search_as_you_type` fields (operator AND), a fuzzy subject match, and a case-insensitive `*q*` wildcard on the recipient. So partial addresses like `globex` and subject prefixes like `roadm` both work.
  - Pagination uses `from/size` (up to 10,000 results) and returns `{ items, page, pageSize, total, totalPages }`.
- **Consistency:**
  - PostgreSQL is the source of truth. An ES failure is logged and never turns a successful send into a failure.
  - Repair with `npm run reindex` (upsert all rows from Postgres), or `npm run reindex -- --recreate` (drop and recreate with fresh mappings first).

### Slack notifications

- Bot token scopes are `chat:write` and `im:write`. The token is stored encrypted (AES-256-GCM) and is never sent to the frontend or logged.
- On `RATE_LIMITED`, the worker calls `notifyRateLimit`:
  1. It loads the connection fresh from the DB (no caching, so connecting later works immediately).
  2. `SET slack-rate-limit-notified:<userId>:<senderId>:<UTC-hour> 1 NX PX 2h` ensures only the first worker proceeds.
  3. It counts the remaining scheduled emails, then calls `conversations.open` and `chat.postMessage`.
- If Slack isn't connected, it does nothing. Errors are logged, never thrown. If posting fails, the dedupe key is released so the next rate-limited job in that window can retry the alert.

### No cron

This repository contains **no cron scheduler**: no `node-cron`, `cron`, crontab, Agenda, Bree, OS tasks, `setInterval` scheduling or per-email `setTimeout`. Future work is always a **BullMQ delayed job**. Reconciliation runs **once at worker startup**; it is not recurring.

One honest footnote: BullMQ itself depends on `cron-parser`, a pure parsing library it uses for its optional repeatable-jobs feature. This project doesn't use repeatable jobs.

```bash
# audit (from the repo root)
grep -rniE "node-cron|agenda|bree|crontab|setInterval|repeat:" backend/src frontend/src   # → no matches
```

---

## API

All responses are `{ "success": true, "data": … }` or `{ "success": false, "error": { "code", "message", "details?" } }`. The one exception is `/api/health`, which returns `{ status, services }`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/health` | – | `{ status: "ok", services: { database, redis, elasticsearch } }` (503 if any are down) |
| GET | `/api/auth/google` | – | Start Google login (302) |
| GET | `/api/auth/google/callback` | – | OAuth callback (302 to the app) |
| GET | `/api/auth/me` | ✔ | `{ id, name, email, avatarUrl }` |
| POST | `/api/auth/logout` | – | Destroy the session |
| POST | `/api/emails/schedule` | ✔ | Schedule a campaign (201; 200 on idempotent replay) |
| GET | `/api/emails/scheduled` | ✔ | ES search over SCHEDULED + SENDING (`q`, `page`, `pageSize ≤ 100`) |
| GET | `/api/emails/sent` | ✔ | ES search over SENT + FAILED |
| GET | `/api/emails/stats` | ✔ | Sidebar counts `{ scheduled, sent }` |
| GET | `/api/emails/:id` | ✔ | Email detail (user-scoped; other users' IDs return 404) |
| GET | `/api/senders` | ✔ | Sender list (no credentials) |
| POST | `/api/attachments` | ✔ | Upload one file (multipart field `file`) → `{ id, filename, contentType, size }` |
| GET | `/api/attachments/:id` | ✔ | Download (own files only) |
| DELETE | `/api/attachments/:id` | ✔ | Remove an upload that isn't scheduled yet |
| GET | `/api/slack/connect` | ✔ | Start Slack OAuth (302) |
| GET | `/api/slack/callback` | – (state) | Slack OAuth callback |
| GET | `/api/slack/status` | ✔ | `{ connected, teamId, teamName, connectedAt }` |
| DELETE | `/api/slack/disconnect` | ✔ | Revoke and remove the connection |
| GET | `/api/admin/queues` | ✔ | Bull Board UI |

```http
POST /api/emails/schedule
Content-Type: application/json

{
  "subject": "Test Email",
  "body": "<p>Hello from ReachInbox</p>",
  "recipients": ["person1@example.com", "person2@example.com"],
  "startTime": "2026-10-01T10:00:00.000Z",
  "delayBetweenEmailsMs": 2000,
  "hourlyLimit": 200,
  "idempotencyKey": "unique-request-id",
  "attachmentIds": ["<optional ids from POST /api/attachments>"],
  "senderIds": ["<optional sender uuid>"]
}
```

**Other security measures:**
- Helmet on all API routes (relaxed CSP only on the Bull Board sub-app).
- CORS restricted to `FRONTEND_URL` with credentials.
- JSON bodies limited to 2 MB. HTML bodies are sanitized server-side (`sanitize-html`) and again client-side (`DOMPurify`).
- OAuth entry points are rate-limited through a Redis store.
- pino redacts cookies, authorization headers, passwords and tokens. Query strings are dropped from request logs, since OAuth callbacks carry codes.
- Stack traces are never returned in production.

---

## Testing

The tests use **Vitest**. Integration tests run against the **real** Docker services, isolated from dev data:
- database `reachinbox_test` (created by `docker/postgres/init.sql`)
- Redis logical DB 1
- ES index `emails_test`
- queue `email-send-test`

They're configured in `backend/.env.test`, which contains only fake values.

```bash
docker compose up -d
cd backend
npm run test:unit           # 30 tests, no services needed
npm run test:integration    # 57 tests, needs docker compose (applies migrations to the test DB automatically)
npm test                    # both
npm run typecheck && npm run build

cd ../frontend
npm test                    # CSV/TXT lead parser
npm run build               # tsc -b + vite build
```

What's covered:

| Area | Tests |
| --- | --- |
| Auth | Unauthenticated email/sender/me APIs → 401; forged cookie rejected; `/me` shape; Google redirect with state + PKCE; bad OAuth state rejected; `/senders` never leaks SMTP secrets |
| Scheduling | Rows + round-robin senders + deterministic job IDs; one **delayed** job per email with the correct delay; persisted timestamps; delay floor / limit ceiling; validation errors (bad email, past start, malformed JSON); dedupe; per-user access to `/emails/:id` |
| Idempotency | Replay → no new rows/jobs; 5 concurrent identical requests → exactly 1 campaign; key reuse with a different payload → 409; keys scoped per user; replay repairs missing jobs |
| Rate limiting | 40 concurrent reservations across 4 Redis connections → distinct slots ≥ delay apart; 50 concurrent with limit 10 → exactly 10 per window and never more; counter present in Redis; exact next-window timestamp; per tenant/sender isolation; Lua and TS hour labels agree (incl. leap day and year rollover) |
| Rescheduling | Real BullMQ worker: rate-limited jobs end up *delayed* at the next hour starts (in sequence order), `attemptsMade = 0`, zero failed jobs, DB `scheduledAt` updated |
| Duplicate protection | Two processors on the same email → one SMTP send; redelivery of a sent email is a no-op; double enqueue → one job |
| SMTP failures | Pre-acceptance error → back to SCHEDULED for retry; post-DATA timeout → FAILED + `UnrecoverableError` |
| Elasticsearch | Scheduled emails indexed; sent status updated; search by full/partial recipient and subject word/prefix; other users' emails never returned; API pagination; stats |
| Slack | Not connected → no throw, no message; connected → `chat.postMessage` with the decrypted token; 5 concurrent notifies → 1 message; different sender/hour → new message; connection made later is picked up; status never leaks the token; disconnect; connect URL has `chat:write` and a single-use state |
| Attachments | Auth required; executables, empty and >5 MB files rejected; linked to the campaign and sent with the email byte-for-byte; listed on the detail page and downloadable; other users can neither attach nor download; one campaign per upload (idempotent replay still OK); unscheduled uploads deletable |
| Recovery | Missing jobs recreated at the stored time; existing jobs untouched (idempotent); sent emails never re-enqueued; stale SENDING → FAILED; 1000-email campaign fully rebuilt after wiping the queue |

The SMTP transport and Slack Web API client are **injected** in tests (a recording stub transport and a mock client factory). Production code paths use real Nodemailer SMTP and `@slack/web-api`.

---

## Project structure

```text
.
├── docker-compose.yml            # postgres, redis (AOF), elasticsearch — volumes + health checks
├── docker/postgres/init.sql      # creates the test database
├── backend/
│   ├── prisma/                   # schema.prisma, migrations/, seed.ts
│   ├── src/
│   │   ├── app.ts / server.ts / worker.ts
│   │   ├── config/env.ts         # Zod-validated configuration (fail fast)
│   │   ├── controllers/          # auth, email, slack, health
│   │   ├── routes/               # auth, email, slack routers + /api index
│   │   ├── middleware/           # auth, session (Redis), error handler, auth rate limit
│   │   ├── services/             # scheduler, email, email-processor, rate-limiter, slack,
│   │   │                         # elasticsearch, sender, mail, auth, reconciliation
│   │   ├── queues/email.queue.ts
│   │   ├── workers/email.worker.ts
│   │   ├── lib/                  # prisma, redis, logger, crypto, bull-board, lifecycle, lua/
│   │   ├── validators/           # Zod request schemas
│   │   ├── scripts/              # reindex, create-ethereal-accounts
│   │   ├── types/ utils/
│   └── tests/                    # unit/, integration/, helpers/
└── frontend/
    └── src/
        ├── components/           # EmailList (Scheduled/Sent tables), StatusBadge, SlackConnect,
        │   ├── compose/          # RichTextEditor, RecipientField, SendLaterPopover
        │   └── ui/               # Button, Input, FileUpload, Modal, Popover, Avatar, States
        ├── layouts/ pages/ router/ hooks/ services/ types/ utils/
```

---

## Limitations & trade-offs

- **SMTP is not exactly-once, and no system can make it so.**
  - The app guarantees at most one *normal* send attempt per email: atomic DB claim, deterministic job IDs, and no retries after `DATA`.
  - There is still an unavoidable window: if the process dies **after** the SMTP server accepts the message but **before** `SENDING → SENT` is committed, the outcome is unknown.
  - Such rows are marked `FAILED` ("send outcome unknown") at the next worker start rather than resent. They trade a possible duplicate for a possible false "failed".
  - Every message carries a stable `Message-ID: <emailId@sender-domain>`, which lets the receiving side de-duplicate if one ever went out twice.
- **Single Redis node.** The Lua script derives hour-window keys at runtime, which is fine for a single node but not Redis Cluster (keys would need hash tags).
- **Counters are shared across campaigns.** The hourly counter is per tenant+sender+hour; each campaign's own limit is checked against that shared counter, so a stricter campaign may wait behind a looser one on the same sender.
- **ES pagination** uses `from/size` up to 10,000 results per query; deep paging would need `search_after`.
- **Ethereal** accounts are ephemeral test inboxes. Swapping in a real SMTP provider is a config change (`host/port/secure` in `ETHEREAL_SENDERS_JSON`), but this project intentionally never sends real email.
- **Figma:** the login frame shows email/password fields. They are deliberately **omitted**: the brief forbids fake login, so only Google sign-in is offered.
- **Slack redirect URLs** must be https, so local Slack OAuth needs a tunnel (ngrok/cloudflared). Google accepts `http://localhost`.
