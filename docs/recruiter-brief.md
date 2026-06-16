# Subscription Billing Console - Recruiter Brief

Subscription Billing Console is a personal operations prototype I built to convert manual subscription reconciliation from Excel into a protected web console.

The project is intentionally narrow: it is not positioned as a public SaaS product. It demonstrates how I define an operational problem, design the data structure, build a full-stack tool, protect private data, and verify key behavior after changes.

## What I Built

- React / Vite frontend for a single-operator billing dashboard.
- Express backend with protected API routes.
- Google OAuth login with allowlisted accounts and signed HttpOnly session cookies.
- Data model for members, platforms, subscriptions, payments, temporary charges, monthly history, and ledger events.
- Accounting checks for duplicate payments, temporary charges, archived entities, close readiness, and monthly rollover.
- GenAI capabilities: AI billing reminders with multiple tones, and an interactive AI accounting assistant utilizing function calling and RAG (via Google Gemini).
- Verification workflow with `pnpm run verify`.

## Why It Matters

The original workflow was spreadsheet-like: member records, platform costs, payments, and monthly close checks were easy to update but hard to audit. I rebuilt it as a console where each important operation has a clearer input, rule, output, and verification step.

## What To Review

- `README.md` for setup, privacy boundary, and verification.
- `server.cjs` for API routes, auth protection, backups, and monthly close flow.
- `lib/accounting.cjs` for accounting checks and ledger logic.
- `lib/ai.cjs`, `lib/ai-assistant.cjs`, `lib/ai-reminder.cjs`, `lib/rag.cjs` for GenAI architecture, vector search, and function calling.
- `scripts/test-auth.cjs` for Google OAuth and API protection tests.
- `verify_accounting.cjs` and `verify_rollover.py` for accounting and monthly rollover validation.

## Safe Sharing Note

The repository contains sanitized demo data only. Real `.env`, `database.json`, backups, and handoff notes are ignored by Git. The demo fixture uses generic names such as `Member Alpha` and `Shared Video`.

GitHub: https://github.com/nnnc8/subscription-billing
