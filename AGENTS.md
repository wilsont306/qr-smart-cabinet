# AGENTS.md

See `CLAUDE.md` for the repo constitution (security invariants and hard rules) and
`README.md` for the product overview and demo walkthrough.

## Cursor Cloud specific instructions

Single Next.js 15 (App Router) service, TypeScript + Tailwind v4. There is no
backend/database to run separately: `src/lib/store.ts` is an in-memory stand-in for
PostgreSQL + Redis and `src/lib/lock.ts` simulates the lock controller in-process.

- Dependencies are installed automatically by the startup update script (`npm ci`).
- Run the dev server with `npm run dev` (serves http://localhost:3000). Build/start
  and lint commands are in `package.json` / `README.md`.
- `npm run lint` (`next lint`) is **interactive** in this repo — no ESLint config is
  committed, so it prompts to pick a config and cannot run non-interactively as-is.
  Type checking still runs as part of `npm run build`.
- All state is in-memory and reseeded via `seed()` on first request. Restarting the
  dev server (or a hot reload that re-imports `store.ts`) resets stock, sessions, and
  the ledger back to the seeded demo data — expect state to reset during development.
- Demo auth uses the OTP fallback path. Request an OTP for a seeded user and the
  6-digit code is returned in the `devCode` field / shown on screen (production would
  not expose it). Seeded users: `alex@example.com` (all drawers),
  `sam@example.com` (Cabinet A only). There is no self-registration.
- Google Sheets mirroring is optional and off unless `SHEETS_WEBHOOK_URL` /
  `SHEETS_SECRET` are set (see `.env.example` and `docs/GOOGLE_SHEETS.md`); the app
  runs fully in-memory without them.
