# Integrations setup — Gmail & Notion

Both connectors are **credential-gated**. The code ships inert: with no tokens
configured, every Gmail/Notion tool returns a clear
`… not connected: run the setup in docs/integrations-setup.md` message and the
app keeps running normally. Provide credentials by either route below and the
tools activate on the next call — no code change, no redeploy.

Credentials are resolved in this order:

1. The Postgres **`connectors`** table (row keyed by `name`), when `DATABASE_URL`
   is set. Preferred for production — tokens live in the DB, not the process env.
2. Environment variables (`GOOGLE_*`, `NOTION_TOKEN`). Handy for local dev or
   when you are not running Postgres.

If Postgres is not configured, the env route is used automatically.

---

## Gmail

### 1. Create a Google Cloud OAuth app

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library →** search **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen:**
   - User type **External** (or **Internal** for a Workspace org).
   - Fill app name / support email. Add your Google account under **Test users**
     while the app is in "Testing" (test-mode refresh tokens are fine here).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type **Desktop app** (simplest) — or **Web application** if you
     prefer a redirect flow.
   - Note the **Client ID** and **Client secret**.
   - For a Web app, add a redirect URI (e.g. `http://localhost:3000/oauth2callback`)
     and remember it — you will store it as `redirect_uri` / `GOOGLE_REDIRECT_URI`.

### 2. Get a refresh token

You need a **refresh token** for the account whose mailbox Shivani will use.
Use the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/):

1. Click the gear (top right) → **Use your own OAuth credentials** → paste your
   Client ID + secret.
2. In **Step 1**, add these scopes (adjust to taste — least privilege wins):
   - `https://www.googleapis.com/auth/gmail.readonly` (search + read)
   - `https://www.googleapis.com/auth/gmail.compose` (drafts)
   - `https://www.googleapis.com/auth/gmail.send` (send)
   - or simply `https://mail.google.com/` for full access.
3. **Authorize APIs**, sign in with the target account, consent.
4. **Step 2 → Exchange authorization code for tokens.** Copy the **refresh token**.

### 3. Store the credentials

**Option A — Postgres `connectors` table (recommended):**

```sql
INSERT INTO connectors (name, tokens)
VALUES ('gmail', jsonb_build_object(
  'client_id',     'YOUR_CLIENT_ID',
  'client_secret', 'YOUR_CLIENT_SECRET',
  'refresh_token', 'YOUR_REFRESH_TOKEN',
  'redirect_uri',  'http://localhost:3000/oauth2callback'  -- only for Web-app clients
))
ON CONFLICT (name) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = now();
```

Recognised keys in `tokens`: `client_id`, `client_secret`, `refresh_token`,
`access_token` (optional), `redirect_uri` (optional).

**Option B — environment variables:**

```bash
GOOGLE_CLIENT_ID=YOUR_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN=YOUR_REFRESH_TOKEN
# optional:
GOOGLE_ACCESS_TOKEN=...
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
```

A client is built only when **client id + secret AND (refresh token OR access
token)** are all present; otherwise the tools stay in the "not connected" state.
The library refreshes the short-lived access token from the refresh token
automatically.

### Gmail tools

- `gmail_search` — Gmail search syntax (`from:`, `is:unread`, `newer_than:7d`, …);
  empty query lists the recent inbox. Returns per-message `id`.
- `gmail_read` — full headers + plain-text body for one message id.
- `gmail_draft` — create a draft (saved, **not** sent).
- `gmail_send` — send immediately (irreversible; prefer drafting).

---

## Notion

### 1. Create an internal integration

1. Go to <https://www.notion.so/my-integrations> → **New integration**.
2. Give it a name, pick the workspace, set capabilities (Read content; Insert
   content; and Update content if you want appends). Submit.
3. Copy the **Internal Integration Secret** (starts with `secret_` / `ntn_`).

### 2. Share pages with the integration

Notion integrations only see pages explicitly shared with them:

- Open the page (or a parent page/database) → **`•••` menu → Connections →**
  add your integration. Child pages inherit the connection.
- For `notion_write` **create** mode, share the **parent page** you will create
  under. For **append** mode, share the target page.

### 3. Store the token

**Option A — Postgres `connectors` table (recommended):**

```sql
INSERT INTO connectors (name, tokens)
VALUES ('notion', jsonb_build_object('token', 'YOUR_NOTION_SECRET'))
ON CONFLICT (name) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = now();
```

Recognised keys in `tokens`: `token` (or `access_token`).

**Option B — environment variable:**

```bash
NOTION_TOKEN=YOUR_NOTION_SECRET
```

### Notion tools

- `notion_search` — search shared pages; returns `id` + title + url.
- `notion_read` — a page's title plus the plain text of its blocks.
- `notion_write` — with a `title`, create a new child page under `parent_id`;
  without a `title`, append the content (one paragraph per line) to `parent_id`.

Page ids can be copied from a page URL (the trailing 32-hex chunk) or taken from
`notion_search` output.

---

## Wiring the tools in (integrator note)

The tool modules live at `src/agent/tools/gmail.ts` and `src/agent/tools/notion.ts`.
Register them in `src/agent/tools/index.ts`:

```ts
import { gmailSearchTool, gmailReadTool, gmailDraftTool, gmailSendTool } from './gmail.js';
import { notionSearchTool, notionReadTool, notionWriteTool } from './notion.js';

// …then add to the `tools` array:
//   gmailSearchTool, gmailReadTool, gmailDraftTool, gmailSendTool,
//   notionSearchTool, notionReadTool, notionWriteTool,
```

Install the runtime dependencies:

```bash
npm install googleapis @notionhq/client
```
