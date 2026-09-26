# Personal entry and responsiveness verification

The current release adds the polished travel interface, hides diagnostics in the personal workspace, and gives the personal entry a fresh conversation with new conversation and research bots. Earlier trips remain archived for recovery. Their events and pending work are not forwarded to the new bots. Designated tester workspaces retain the debug panel.

Transcript polling now prioritizes sends and active replies. Unused tester bots stay idle, while recently active bots are checked less frequently after their tasks finish. Conversation prompts ask for a short reply and structured updates immediately, leaving browsing to the research bot and search services.

## Checks

The full deterministic suite passed **241 tests**, with nine opt-in live tests skipped while the worker was active. TypeScript, the local production build and the Vercel build passed.

Ten production API checks passed at 16:13:51 UTC on 26 September 2026. They covered sign-in, rejection of unauthenticated access, personal history, the old link resolving to the fresh trip, empty conversation and criteria, exclusion of archived history, credential absence in the response and an online worker. These API checks do not establish browser layout quality.

A separate production browser check passed on desktop and mobile. The original submitted URL opened the fresh trip, the personal history contained one current trip, and diagnostics remained hidden even when the old URL included `debug=1`. The page made no debug endpoint requests. Both layouts loaded without horizontal overflow or browser JavaScript errors.

Owner checks apply to both the saved link and its target. Reads may follow the alias; writes through an old link return 409 and require a refresh. Internal worker lookups remain exact, preventing old bot receipts from following the web alias into the fresh trip.

## One live conversation check

A separate slower-travel tester sent one message considering Ljubljana for five nights the following month, with art, good food and a private bathroom, and explicitly asked not to search yet. The personal workspace received no test message.

Grok answered with one 26-word request for departure city, traveller count, budget and date flexibility. It retained the private-bathroom requirement, left the unknown essentials unconfirmed and created **zero provider jobs**. There was one conversation command, completed successfully.

| Measurement | Observed value |
| --- | --- |
| Send click to the user's message appearing in the DOM | 4 ms |
| Send click to the complete assistant reply appearing in the DOM | 13.979 seconds |
| Saved assistant event to its DOM appearance | 592 ms |
| Grok message timestamp to bridge observation | 3.226 seconds |

These are measurements from one foreground browser run, not averages or percentiles. DOM appearance is not a measured screen-paint timestamp. Database and bridge comparisons use timestamps from different machines and may include clock differences. No price searches were requested, so this run does not measure time to a shortlist or manual browsing performance.

The [earlier live-run report](LIVE-RUN.md) and [edited product video](demo-video.md) remain historical evidence from before this polling change. Native spoken voice remains unverified.

The reproducible script is `scripts/quality-slower.mts`. It requires `--send-live`, uses the registered slower-travel tester bot, refuses to send when that workspace has queued or running work, and does not resend a rejected or uncertain message. Its local output contains trip diagnostics and stays under the ignored `output/` directory.
