# Roamer interface

The user’s chat screenshot defines the rounded white panel, pale user messages, unboxed assistant text, muted activity rows and anchored composer. Their travel screenshot defines the pastel icon tiles, white cards, black text and destination photography. Measurements are estimates from the screenshots, not extracted design tokens.

The opening conversation fills the workspace. Sending the first prompt reveals the desktop trip panel with a 220ms transition: conversation at 58%, trip at 42%. Each panel scrolls independently. Below 1,000 pixels, Chat and Your trip become tabs; both remain mounted so scroll positions and drafts survive switching. Reduced-motion preferences disable the reveal animations. The phone layout is an adaptation of the supplied references.

Palette: white #FFFFFF, background #F3F3F5, text #191919, purple #6548E8, lilac #EEEAFE and mint #DCF3F1. Inter is stored locally under its SIL Open Font License. Lucide provides consistent functional icons. Buttons describe their action, and status text describes observed work.

Images are part of the research interface, not evidence of a booking. Destination photos have attribution in public/images/attribution.json and in the app’s Photography & sources dialog. Hotel images come from the property named in the result. A missing image receives a labelled fallback.

The empty view offers visual suggestions without prices. Active searches show acknowledged jobs and elapsed time. Partial results keep unverified prices blank. Cards keep their order as results arrive, and the conversation follows new messages only while the reader is near the bottom.

Reference research: https://github.com/Nutlope/inspo. Its Hopper example informed the small photo-led destination cards. It does not replace the supplied screenshots.
