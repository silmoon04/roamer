# Recorded live scenario

This run used the deployed Roamer interface, a dedicated tester conversation bot, its research bot, and real search services. It did not use the personal conversation workspace. The edited video shortens waiting; the measurements below come from the unedited run.

This recording predates the later interface polish and transcript-polling changes. Its timings describe that captured run, not a fresh benchmark of the current worker.

The scenario covered two people travelling from London for five nights, a £1,000 total budget, hiking, good food and cosy accommodation. While searches continued, the tester added that neither person drives, requested another stay, and changed the departure date from 12 to 13 October 2026 while asking for a private bathroom.

## Measured progress

| Event | Observed time |
| --- | --- |
| First conversation command, queued to done | 14.29 seconds |
| Initial destination discovery | 19.3 seconds |
| Reply after supplying essential trip details | 16.23 seconds |
| Reply to the no-driving update, while searches continued | 10.35 seconds |
| First dated fare checked by provider | 105.7 seconds from the initial request; 61.2 seconds after essential details |
| Reply to the stay replacement request | 10.12 seconds |
| Reply to the date and private-bathroom update | 12.72 seconds |

Conversation timings are command completion measurements, not click feedback or browser paint measurements. They do not establish that every response appeared on screen at exactly that point. The first stay's provider check followed the fare by about 0.21 seconds; the fare was committed to the database 106.64 seconds after the initial request.

Six observed Grok-message-to-bridge delays were 5.158, 7.370, 3.732, 3.590, 5.328 and 4.041 seconds. Three of the six exceeded the five-second target.

## Results and unfinished checks

The first 12–17 October comparison returned £127 for return flights and £200.29 for the whole stay. After the date change, old quotes were removed and an interrupted stay search was superseded. The 13–18 October comparison returned £113 for flights and £258.62 for the Cozy Loft stay. These are recorded provider prices for the specified two-person trip, not offers guaranteed to remain available. Food, local transport and optional extras are outside these amounts.

Both manual browser checks reached the 90-second worker response deadline. Delivery of their stop requests was uncertain; this does not prove that browser execution stopped after 90 seconds. The first check was superseded after the date change. The second returned scoped evidence after about 139 seconds and supported the selected property's private bathroom. A suitable no-car hiking and food route remained unknown. The candidate therefore remained partial; this was not a fully checked shortlist or a booking.

The run also exposed a need to preserve rejected stays across later date changes and reject rooms explicitly described as having a shared bathroom when a private bathroom is required. Those source changes passed focused regression tests after the recording. They were not demonstrated by repeating this live run.

Native spoken voice remains unverified. This recording covers website text interaction and visual updates.
