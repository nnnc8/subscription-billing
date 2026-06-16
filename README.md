# Subscription Billing Console

Single-operator subscription billing console for turning spreadsheet-based reconciliation into an auditable internal operations tool.

This project is a portfolio prototype, not a public SaaS product. I built it around a narrow personal workflow so I could practice the full cycle of requirements definition, data modeling, authentication, API design, accounting checks, and regression verification.

## What It Solves

Small subscription-based operations often start in Excel: members, platforms, payments, temporary charges, monthly closing, and exceptions live in separate sheets or notes. That makes it hard to answer simple operational questions:

- Which members still have unpaid balances?
- Did someone enter the same payment twice?
- Which subscriptions should roll into the next month?
- Can historical records still be traced after members or platforms are archived?
- Did a code change break login, data boundaries, or accounting rules?

Subscription Billing Console converts those spreadsheet-like steps into a web console with protected API routes, demo data, accounting warnings, a monthly close workflow, and verification scripts.

## Highlights

- **Operations data model**: members, platforms, subscriptions, payments, temporary charges, monthly history, and ledger events.
- **Accounting checks**: duplicate payment detection, temporary charge checks, close-readiness preview, archived member/platform handling, and rollover validation.
- **Tamper-evident ledger summary**: important writes append hash-linked ledger events and expose a `GET /api/ledger` audit view.
- **Google account login**: OAuth login with allowlisted emails, signed HttpOnly session cookies, and protected `/api/*` routes.
- **Privacy boundary**: real `.env`, `database.json`, backups, and handoff notes are ignored by Git; tracked demo data is sanitized.
- **Regression verification**: `pnpm run verify` checks authentication, API protection, Git privacy, accounting invariants, rollover behavior, and portability.
- **Generative AI Capabilities**: Smart billing reminder generation with custom tones (pirate, poetic, professional, friendly, urgent), and an interactive AI accounting assistant utilizing function calling and RAG.

## Tech Stack

- React 19
- Vite
- Express 5
- Google OAuth
- Node.js 20+
- GitHub Actions
- pnpm
- **AI Integration**: Google Gemini (via AI Studio / Vertex AI), In-memory RAG, and tool calling.

## Demo Data And Privacy

The repository stores code and sanitized demo data only.

Tracked demo and example files:

- `fixtures/demo-database.json`
- `database.example.json`
- `.env.example`

Ignored live files:

- `.env`
- `database.json`
- `backups/*.json`
- `session_handoff.md`
- `data/`

When `database.json` is missing, the server bootstraps a disposable demo database from `fixtures/demo-database.json`. Real billing data should stay in an ignored local `database.json` or in a private deployment volume such as `/data/database.json`.

## Local Setup

Requirements:

- Node.js 20 or newer
- pnpm 11.1.2, or npm as a fallback

Install and build:

```bash
git clone https://github.com/nnnc8/subscription-billing.git
cd subscription-billing
pnpm install
pnpm run build
```

Create a local `.env` file from `.env.example`. This file is ignored by Git.

```env
PORT=3000
HOST=127.0.0.1
DATA_DIR=.
APP_SESSION_SECRET=replace-with-at-least-32-random-characters
GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
GOOGLE_ALLOWED_EMAILS=your-account@example.com
```

In Google Cloud Console, create an OAuth client with application type `Web application` and add this authorized redirect URI:

```text
http://localhost:3000/api/auth/callback
```

Start the app:

```bash
pnpm run start
```

Open:

```text
http://localhost:3000
```

## Verification

Run the same checks used for local review and CI:

```bash
pnpm run verify
pnpm run lint
pnpm run build
```

`pnpm run verify` runs:

- Google auth and API protection tests
- Git privacy checks
- Accounting invariant checks
- Monthly rollover checks
- Portability checks for macOS LaunchAgent generation

For local sensitive-term scanning, put one private term per line in an ignored `.privacy-terms` file and run:

```bash
PRIVACY_GREP_TERMS_FILE=.privacy-terms pnpm run verify
```

## Auth Model

- `GET /api/auth/login`
- `GET /api/auth/callback`
- `POST /api/auth/logout`
- `GET /api/auth/session`
- `GET /api/health`

All other `/api/*` endpoints require a signed HttpOnly cookie. Sessions use `SameSite=Lax`, expire after 7 days, and set `Secure` automatically in production. Google OAuth tokens are only used during callback handling and are not stored in `database.json`.

## Deployment Notes

For Railway-style deployment, set these variables and attach a persistent volume mounted at `/data`:

```env
DATA_DIR=/data
HOST=0.0.0.0
PORT=3000
APP_SESSION_SECRET=replace-with-at-least-32-random-characters
GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
GOOGLE_ALLOWED_EMAILS=your-account@example.com
NODE_ENV=production
```

In the Google OAuth client, add the deployment callback URL:

```text
https://your-domain.example/api/auth/callback
```

Build command:

```bash
pnpm run build
```

Start command:

```bash
pnpm run start
```

Optional:

```env
ALLOWED_ORIGINS=https://your-domain.example
COOKIE_SECURE=true
```

## macOS LaunchAgent

After local `.env` exists:

```bash
pnpm run launchd:install
```

Remove it:

```bash
pnpm run launchd:uninstall
```

The tracked `com.nc8.subscription-billing.plist` is a template only. The install script generates a machine-specific plist in `~/Library/LaunchAgents`.

## AI Features and Architecture

This application showcases several advanced Generative AI and LLM integration patterns, optimized for robust production application:

1. **AI-Powered Billing Reminders (Prompt Engineering & Fallbacks)**:
   - Instead of static string templates, operators can use the **AI Generate** feature to customize billing messages using Google Gemini.
   - Supports five tone styles: *Friendly & Humorous*, *Professional & Formal*, *Wild Pirate*, *Poetic/Aesthetic*, and *Politely Urgent*.
   - Implements a strict fallback to local templates if the API key is missing or calls fail, ensuring zero disruption to the operator's checkout workflow.

2. **AI Accounting Assistant (OpenAI Compatible Function Calling)**:
   - Operators can converse with an interactive AI accountant in a premium chat window.
   - Built with OpenAI-compatible tool calling. The assistant can autonomously request data via database search functions like `get_member_balance`, `get_member_history`, `get_payment_records`, `get_accounting_warnings`, and `get_system_snapshot`.
   - Handles multi-turn function loops to calculate details and verify state before responding.

3. **In-Memory RAG Pipeline (Retrieval-Augmented Generation)**:
   - To query system logs, past months' balances, and historical ledger events without bloating the LLM context, we implement a custom in-memory vector indexing pipeline.
   - Generates text chunks of ledger events, history summaries, payments, platform pricing, and active memberships.
   - Rebuilds dynamically when writes occur and computes cosine similarity of query embeddings to inject the top matching historical context into the prompt, enabling the assistant to answer historical questions like *"How much did Beta pay in past months?"*.

## Portfolio Framing

For interviews, the important parts of this project are not the niche subscription workflow itself. The transferable parts are:

- turning an informal spreadsheet process into structured data and API operations
- designing exception checks before monthly close
- protecting private operational data from public Git tracking
- using OAuth and signed sessions to restrict access
- writing repeatable verification for auth, accounting, privacy, and rollover behavior

See [`docs/recruiter-brief.md`](docs/recruiter-brief.md) for a short version that can be shared in an application message.
