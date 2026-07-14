# 03 — Trust、domain、OAuth 與 AI boundary

## Mission

Close the trust boundary at HTTP/OAuth/CORS/AI edges while keeping business invariants deterministic and preserving route contracts.

## Preconditions

- The runner must prepend or read docs/luna-plan/02-luna-runbook.md; direct invocation without it is invalid.

- 01A, 01B and 02 are verified_complete.
- Use fake credentials and mock external fetch. Paid Gemini is not allowed in this batch.

## Exact write set

- server/app.ts
- server/runtime.ts
- lib/accounting.ts
- server/middleware/cors.ts
- server/middleware/validation.ts
- server/middleware/auth.ts (existing boundary read-back; exact edit only if required by this batch)
- server/routes/auth-runtime.ts
- lib/google-oauth.ts
- lib/ai.ts
- lib/automation.ts (existing AI boundary read-back; exact edit only if required by this batch)
- lib/ai-assistant.ts (existing AI boundary read-back; exact edit only if required by this batch)
- tests/security-boundaries.test.ts
- tests/domain-validation.test.ts
- tests/ai-transport.test.ts
- docs/luna-plan/01-master-plan.md (status/evidence only)

Do not modify package/lock, frontend, Docker, CI, plist or production env.

## Required implementation

1. trust proxy defaults false. Enable only when non-empty TRUST_PROXY_CIDRS is valid and matched.
2. Public/cloud binding requires valid PUBLIC_ORIGIN. OAuth uses valid GOOGLE_REDIRECT_URI, otherwise exactly PUBLIC_ORIGIN + /api/auth/callback.
3. CORS allows only PUBLIC_ORIGIN and normalized ALLOWED_ORIGINS. Never derive or reflect request forwarded headers as authorization.
4. Zod validates HTTP payloads, OAuth/external shapes, Gemini unknown JSON, function-call shape, type/size/enum/format.
5. Domain layer in server/runtime.ts and lib/accounting.ts validates unique IDs/names, orphan references, start/exit order, active duplicate, valid calendar date, payment cycle and current active month on fresh DB.
6. Implement generateContent(body, schema, options) with caller-provided Zod schema, default 20-second timeout, caller cancellation and key-safe errors.
7. Do not add AiProvider, asyncHandler or Supertest solely to satisfy a pattern.

## Checks

~~~bash
pnpm test --run tests/domain-validation.test.ts tests/security-boundaries.test.ts tests/ai-transport.test.ts tests/server.integration.test.ts
pnpm test --run
pnpm exec tsc --noEmit -p tsconfig.app.json
pnpm exec tsc --noEmit -p tsconfig.node.json
~~~

Prove spoofed X-Forwarded-Host/Proto cannot authorize an origin, invalid public binding fails closed, OAuth callback is deterministic, malformed Gemini JSON is rejected, timeout/cancellation aborts fetch, and API keys do not appear in errors.

## Failure, retry and rollback

Attempt limit: initial run, retry 1 and retry 2 only; each retry requires a new falsifiable hypothesis. After retry 2, restore product/prompt preimages, keep the master ledger status/evidence append-only, verify hashes and stop.

If a required public-origin value is missing, do not invent a request-derived fallback. If a schema rejects a legacy valid response, update the caller schema with evidence; do not weaken validation to unknown/any. Retry only with a new falsifiable hypothesis, then restore product/prompt preimages while preserving the master ledger.

## Evidence and next

Record env matrix, HTTP status/headers, mock fetch abort signal, schema failures and redacted errors. Next is 04 only when trust and AI boundaries are proven without paid API.
