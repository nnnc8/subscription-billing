# Subscription Billing Console

Single-operator subscription billing console with audit checks, recovery backups, monthly rollover, and server-side password login.

The repository stores code and sanitized demo data only. Real billing data belongs in an ignored local `database.json` or in the Railway persistent volume at `/data/database.json`.

## Requirements

- Node.js 20 or newer
- pnpm 11.1.2, or npm as a fallback
- A private GitHub repository

## Local Setup

```bash
git clone https://github.com/nnnc8/subscription-billing.git
cd subscription-billing
pnpm install
pnpm run build
```

Create a local `.env` file. This file is ignored by Git.

```bash
pnpm run hash-password
```

Put the generated hash into `.env`:

```env
PORT=3000
HOST=127.0.0.1
DATA_DIR=.
APP_PASSWORD_HASH=scrypt$...
APP_SESSION_SECRET=replace-with-at-least-32-random-characters
```

Start the app:

```bash
pnpm run start
```

Open:

```text
http://localhost:3000
```

If `database.json` does not exist, the server bootstraps a sanitized demo database from `fixtures/demo-database.json`. Replace it with your real ignored `database.json` when restoring production data locally.

## Privacy Boundary

Tracked demo and example files:

- `fixtures/demo-database.json`
- `database.example.json`

Ignored live files:

- `database.json`
- `session_handoff.md`
- `backups/*.json`
- `.env`
- `data/`

Run this before pushing:

```bash
pnpm run verify
pnpm run doctor
```

`pnpm run verify` checks auth, API protection, Git privacy, accounting invariants, rollover behavior, and portability.

For local sensitive-term scanning, put one private term per line in an ignored `.privacy-terms` file and run:

```bash
PRIVACY_GREP_TERMS_FILE=.privacy-terms pnpm run verify
```

## Auth Model

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/session`
- `GET /api/health`

All other `/api/*` endpoints require a signed HttpOnly cookie. Sessions use `SameSite=Lax`, expire after 7 days, and set `Secure` automatically in production. Passwords are verified with scrypt hashes from `APP_PASSWORD_HASH`; plaintext passwords are never committed.

## Railway Deploy

Set Railway variables:

```env
DATA_DIR=/data
HOST=0.0.0.0
PORT=3000
APP_PASSWORD_HASH=scrypt$...
APP_SESSION_SECRET=replace-with-at-least-32-random-characters
NODE_ENV=production
```

Attach a persistent volume mounted at `/data`.

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

The generated LaunchAgent runs `server.cjs`; the server reads the ignored `.env` file from the project directory.

## Accounting Protections

- Tamper-evident ledger summary at `GET /api/ledger`
- Close readiness preview at `GET /api/close-preview`
- Atomic settings save at `POST /api/update-config-bundle`
- Duplicate payment and temporary charge detection within 10 minutes
- Void transactions instead of hard deletion
- Archive members and platforms instead of hard deletion
- Sanitized fixture includes an intentional duplicate-seat case so the verifier protects the multi-seat business rule without exposing real names
