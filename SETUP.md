# Service setup

Roamer has a Next.js website, a Supabase database and a local Node worker. The deployed demo is [roamer-chi.vercel.app](https://roamer-chi.vercel.app). Its access code is private.

## Prerequisites

- Node.js 24 and npm.
- A Supabase project with the migrations in `supabase/migrations` applied in filename order.
- A dedicated Supabase demo user and a private password used as `ROAMER_ACCESS_CODE`.
- Tavily and Apify credentials for searches.
- The Grok desktop app, signed in, with dedicated conversation and research bots.

Install the pinned dependencies with `npm ci`. The community `grok-bot-cli` dependency is pinned to version `0.9.0`; it uses the desktop app's local session. No OpenAI API key is needed.

## Local configuration

Copy `.env.example` to `.env.local` and fill in the values for your own project. Keep both `.env` and `.env.local` private. The worker command loads both files, so create an empty `.env` if your values are all in `.env.local`.

| Variable | Used by |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Website and worker |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Website |
| `SUPABASE_SERVICE_ROLE_KEY` | Server routes and worker only |
| `ROAMER_USER_ID`, `ROAMER_USER_EMAIL` | Dedicated demo account |
| `ROAMER_ACCESS_CODE` | Private demo sign-in |
| `TAVILY_API_KEY`, `APIFY_TOKEN` | Local worker only |

The existing `scripts/setup-local.mjs` is an operator helper, not a complete installer. It creates the dedicated demo user when its ID is missing. If `APIFY_TOKEN` is absent, it expects an authorised `APIFY_KEY_1` in a sibling `misc/.env`; otherwise, set the token directly before using the helper.

Register each workspace in `roamer_workspaces` with its owner ID, conversation bot ID and optional separate research bot ID. Trips retain those bindings. Provisioning scripts under `scripts/` depend on local receipts in `.roamer/`; review them before running on another machine. They are not a one-command setup flow.

## Start the application

```powershell
npm run dev
```

In a second terminal, with Grok signed in:

```powershell
npm run worker
```

Open `http://127.0.0.1:3000`. The worker must remain running for conversation and research. Supabase restores saved trips when the browser reconnects. See the [worker documentation](src/worker/README.md) for bot routing, queue recovery and provider limits.

## Deploy the website

Vercel needs the two `NEXT_PUBLIC_SUPABASE_*` values, `SUPABASE_SERVICE_ROLE_KEY`, `ROAMER_USER_ID`, `ROAMER_USER_EMAIL` and `ROAMER_ACCESS_CODE`. Keep the Tavily and Apify keys, Grok session credentials and local receipts on the laptop. The deployment contains the website and API routes; it does not host the Grok worker.

The included `vercel.json` configures the Next.js deployment in London. This demo uses a cloud Supabase database; local Docker is not required.

## Verify changes

```powershell
npm run typecheck
npm test
npm run build
```

Browser and live integration tests have separate requirements. Read the [README](README.md#checks) before running them: fixtures can enqueue real work if a worker is active. Use dedicated tester workspaces and never reuse a person's conversation bot for automated tests.

Native Grok voice synchronisation remains unverified. Website text and clicked-answer tests do not establish voice support.
