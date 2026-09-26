# Personal testing handoff

These notes record the earlier handoff and its measurements. The current personal interface hides the debug panel; diagnostics remain available in designated tester workspaces. Later fixes and live evidence are documented in [recovery verification](RECOVERY-VERIFICATION.md) and the [recorded live run](LIVE-RUN.md).

Open `.roamer/Open Roamer.html` on this laptop to enter the [hosted app](https://roamer-chi.vercel.app). The launcher contains private access details; do not publish or attach it to reports. Your chat uses **Roamer Personal**, and browser research uses **Roamer Personal Research**. Tester trips have separate bots and preferences. Automated tester submissions are paused while you try your workspace.

Keep Grok signed in and the laptop worker running. Text and clicked answers are supported by the website. Native voice stays in Grok; a real spoken interaction on Roamer Personal still needs to prove that it updates the website. Spoken synchronisation remains unverified.

## Record what happens

Open **Debug view** at the bottom of the workspace. **Timing & tasks** separates waiting from running, **Inputs & outputs** shows saved updates, and **Your feedback** accepts a note about what felt wrong or unclear. **Save testing note** stores feedback with the trip without sending a message to Grok. Use **Export JSON** when a saved copy of the timings and events is useful.

The debug panel refreshes every five seconds. Database and bridge timings compare timestamps from different machines, so clock differences can affect them. Browser render time alone is not database propagation time. A task with uncertain delivery should be checked in Grok before resending; an automatic resend could duplicate a message already accepted upstream.

## Known rough parts

The earlier parallel stress tests exposed problems that separate bots do not solve by themselves:

| Requirement | What happened | What still needs checking |
| --- | --- | --- |
| Step-free entrance **and** a lift to the room or confirmed ground-floor room | Grok reduced the requirement to **step-free or lift**, while the full wording remained in profile notes. | Preserve the entrance requirement and room-access alternatives separately. A lift does not prove that the entrance is step-free. |
| Three separate real beds, with no shared bed or sofa bed | The selected three-person apartment had a large double bed and a sofa bed. | Occupancy capacity does not establish bed configuration. This offer contradicted the request. |
| Private hotel room, quiet area, limited walking | Apartment offers appeared; property access and quiet location were unverified. A cheap self-transfer flight was selected without checking journey effort. | Check property type, the selected room, access, connections and walking demands against the actual request. |
| Changed departure dates | Current quotes used the new dates, but one candidate summary still described the earlier dates. | Compare criteria, quote dates and narrative summaries; a correct price does not repair stale copy. |

**A source-backed price does not verify suitability.** A booking link, listing photo or valid whole-stay quote does not establish accessibility, private-hotel status, bed layout, quietness, dietary options or an arrival deadline. Unchecked requirements need to remain visible. Failed searches must not be filled with invented prices; a missing flight quote means a complete flight-and-stay total is unavailable. Meals, local transport and other estimates remain separate from checked flight and accommodation prices.

## Speed and test coverage

The three-minute useful-demo target was not met consistently on the earlier shared bot. The slower-travel run took 173 seconds to show research sources, 238 seconds for its first room price and 707 seconds for a browser airfare. The friends run took 217 seconds for a useful source and 253 seconds for a room price. Neither completed a checked shortlist within its 15-minute window. The careful-couple run waited about 127 seconds in the queue and then hit an uncertain bridge-delivery failure before any reply.

Dedicated bots and a separate personal research bot now remove that shared conversation bottleneck. Their full live scenario latency has not yet been measured. Do not treat the routing change as a proven three-minute result.

The handoff checks include **135 passing unit tests**, **seven live isolation checks**, and a rolled-back database transaction proving that tester preferences do not overwrite personal preferences. The personal workspace, history, voice instructions and debug timing/events/feedback panels were inspected at **390 and 1440 pixels**, without horizontal overflow or JavaScript errors. A feedback note saved successfully on a disposable tester trip and queued no Grok command. The personal trip remained untouched. These checks do not verify a real spoken turn or a suitable completed shortlist.

Evidence is retained in `output/personal/`, `output/tests/workspace-isolation.json`, and the three `output/stress/*/report.md` files. The baseline reports distinguish observed failures from changes made afterward; use those distinctions when deciding what needs another test.
