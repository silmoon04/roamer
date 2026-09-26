# Service setup

Checked on 26 September 2026. Supabase, v0, and Tavily credits are confirmed. Cursor's referral is already used, but its account credit balance could not be verified.

## Local tools

- Cursor 3.8.11 is installed and its command runs.
- Node.js 24.18.0, npm 10.9.1, and Git 2.47.1 are available.
- This folder has the Supabase JavaScript client 2.117.2 and Tavily client 0.7.13. Both imports passed; the final project dependency audit reported zero vulnerabilities.
- Supabase CLI 2.118.0 is installed in this project; Vercel CLI 60.1.3 is installed globally. Both version checks passed.
- Docker is installed, but its Linux engine is not running. A local Supabase stack has not been started.

The folder was empty before setup. It now contains tooling dependencies, a lockfile, a secret-file ignore list, `.env.example`, and a local `.env` containing the Tavily API key. There is no application or deployment yet.

## Accounts and credits

| Service | Verified setup | Credit status |
| --- | --- | --- |
| Cursor | Desktop command works. Browser signed in to the City University account, showing Free plan. | Referral says already used. You confirmed redemption on this account, but billing and checkout did not display a credit balance or discount. Cursor support or the event organizer must clarify the remaining balance. |
| Supabase | Browser and CLI authenticated. Created `silmoon04's Org` on Free plan, organization `octcbjwqnwgfapqevrvv`. Spend cap enabled. | $25.00 credit balance confirmed after CAPTCHA completion. No expiry was shown. |
| Vercel / v0 | Vercel CLI authenticated as `hssilmoon12-6459`, workspace `hssilmoon12-gmailcoms-projects`, Hobby plan. v0 shows complimentary Plus. | Redeemed $30 in v0 credits, bringing the displayed total to $40. The added $30 expires 26 October 2026. These are v0 credits; this does not establish a Vercel hosting credit balance. |
| Tavily | Billing-address requirement cleared. Free Researcher account; existing API key configured locally. Browser and local SDK searches passed. | 8,000 add-on credits redeemed, in addition to the 1,000 monthly allowance. Verification searches consumed 3 credits in total. |

The promo codes remain in the chat and are not stored in this project. No paid subscription or credit purchase was completed. v0 auto-recharge and Tavily pay-as-you-go/auto-upgrade are disabled.

## Configuration

The existing `.env` contains the Tavily API key and is ignored by Git. Keep this key in server-side code. Do not overwrite `.env` with the example or put the key in a browser-exposed environment variable.

Supabase URL and publishable-key entries in `.env.example` remain empty because no database project has been created. The Supabase CLI successfully listed the organization and returned an empty project list. Create and link a project when an application needs one. Docker's stopped engine only matters if you want to run Supabase locally.

Vercel authentication was verified with `vercel whoami --non-interactive --json`. No project is linked or deployed. CLI credentials are managed by the official CLIs rather than stored in this project.

The Tavily SDK was tested using Node's `--env-file=.env` option. It returned a search result and reported one credit used. The preceding browser search consumed two credits. No credential was printed in the setup notes or test output.

Useful checks from this directory:

```powershell
cursor --version
npx supabase --version
npx supabase orgs list
vercel --version
vercel whoami
npm list --depth=0
```

## Official references

- [Cursor](https://cursor.com/)
- [Supabase dashboard](https://supabase.com/dashboard)
- [Supabase CLI installation](https://supabase.com/docs/guides/local-development/cli/getting-started)
- [Vercel CLI](https://vercel.com/docs/cli)
- [v0](https://v0.app/)
- [Tavily dashboard](https://app.tavily.com/)
- [Tavily SDK documentation](https://docs.tavily.com/)

