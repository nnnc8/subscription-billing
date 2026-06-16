# Subscription Billing Console - Recruiter Brief

Subscription Billing Console is a personal operations prototype I built to convert manual subscription reconciliation from Excel into a protected web console.

The project is intentionally narrow: it is not positioned as a public SaaS product. It demonstrates how I define an operational problem, design the data structure, build a full-stack tool, protect private data, and verify key behavior after changes.

## What I Built

- React / Vite frontend (migrated to TypeScript components) for a single-operator billing dashboard.
- Express backend rewritten in TypeScript ESM with protected API routes.
- Robust SQLite database storage (using WAL mode via `better-sqlite3`) for consistent state tracking.
- Google OAuth login with allowlisted accounts and signed HttpOnly session cookies.
- Data model for members, platforms, subscriptions, payments, temporary charges, monthly history, and ledger events.
- Accounting checks for duplicate payments, temporary charges, archived entities, close readiness, and monthly rollover.
- GenAI capabilities: AI billing reminders with multiple tones, and an interactive AI accounting assistant utilizing function calling and RAG (via Google Gemini).
- Automated unit test suite with Vitest (`pnpm test`), alongside compliance/integration verification via `pnpm run verify`.

## Why It Matters

The original workflow was spreadsheet-like: member records, platform costs, payments, and monthly close checks were easy to update but hard to audit. I rebuilt it as a console where each important operation has a clearer input, rule, output, and verification step.

## What To Review

- `README.md` for setup, privacy boundary, and verification.
- `server.ts` for API routes, auth protection, backups, and monthly close flow.
- `lib/accounting.ts` for accounting checks and ledger logic.
- `lib/ai.ts`, `lib/ai-assistant.ts`, `lib/ai-reminder.ts`, `lib/rag.ts` for GenAI architecture, vector search, and function calling (integrated with Google Gemini).
- `tests/` directory for TypeScript unit tests using Vitest.
- `verify_accounting.cjs` and `verify_rollover.py` for compliance and monthly rollover validation.

## Safe Sharing Note

The repository contains sanitized demo data only. Real `.env`, `database.json`, backups, and handoff notes are ignored by Git. The demo fixture uses generic names such as `Member Alpha` and `Shared Video`.

GitHub: https://github.com/nnnc8/subscription-billing
