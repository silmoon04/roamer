# Intake and recovery verification

The production website received one synthetic tester message: "I want to go to Jamaica." The careful-tester workspace used its own bot. No follow-up was sent, and the personal workspace was not used for this conversation test.

The API acknowledged the message in 248 ms. Budget, departure location, party size and dates remained unknown, and no flight, accommodation or browser-price job was created. Grok produced a reply about 7.65 seconds after the send timestamp, but its events omitted the required `payload` wrapper. The website rejected that structured reply and showed a recoverable error instead of inventing a result.

The parser now normalizes that specific flattened format only when `payload` is absent. It still validates the entire event and bundle. Unsupported types, unknown fields, conflicting nested and flattened values, invalid IDs/revisions, null budget patches and invalid source links remain rejected.

The worker was stopped, only the careful bot's transcript cursor was rewound, and the worker then recovered the already-delivered reply. The same conversation command became `done` with confirmed delivery. There was still exactly one user message and one conversation command. A subsequent read-only browser check on production verified that the assistant reply and clarification question were visible, with no browser JavaScript errors and no price jobs. Discovery sources were allowed to arrive while trip details remained unknown.

This recovery is not evidence of a fast first-turn success. The original run failed before the repair, and cursor recovery involved a restart. The recovered question also retained the older protocol's invented bundles of example dates, budgets and party sizes. Those options were not promoted to confirmed criteria. The revised protocol asks for the missing details together in ordinary text instead; a fresh run is needed to evaluate that wording.

## Personal-history repair

A separate, explicitly authorized repair restored confirmation metadata for nine fields supported by a dated user request and clicked answers. It did not change the actual criteria values, messages, questions, profile, candidate evidence or prices. Departure location and party size remained unknown, so dated price searches stayed gated on those answers. An overbroad model-authored destination label was not treated as a user confirmation.

The repair used a version-checked atomic commit and retained an audit event. Exact personal statements and answers are private local audit material and are not reproduced here.

## Requirement handling

Identical requirement text is deduplicated using whitespace normalization only. Original wording and all source IDs remain available; conjunctions, exclusions and other differing words are not merged. Removing a duplicate group through an explicit user edit retires all of its source records. Additional duplicate provenance does not invalidate an otherwise current evidence check.

Current structured dates, party size, budget, origin and nights govern comparisons. Earlier values remain visible in the original request as history. A regression test preserves an original 12 October request, accepts only the newly selected 13 October prices and evidence, and rejects an old-date quote. Source evidence is still required for suitability; price verification alone cannot establish access, bed layout or room requirements.

The integrated verification after these changes passed 227 tests across 17 files, with nine opt-in live queue tests skipped while the worker remained active. TypeScript passed.

Local evidence files are `output/final/intake.md`, `intake.json`, `intake-recovery.json`, and `intake-recovered-1440.png`. Native spoken voice remains unverified.
