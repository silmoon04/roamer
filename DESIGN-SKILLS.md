# Codex skills for website references and recreation

Researched 26 September 2026. This is a source review, not a comparative rendering benchmark. The four shortlisted skills were subsequently installed at the user's request, along with the `web-design` master skill.

## Installed setup

Use `$web-design` followed by your request. It selects the relevant design workflow and loads only the supporting skills needed for that task. It is available for automatic selection as well as explicit invocation.

| Skill | Installed location |
| --- | --- |
| web-design (master router) | `C:/Users/hssil/.codex/skills/web-design/SKILL.md` |
| frontend-design | `C:/Users/hssil/.agents/skills/frontend-design/SKILL.md` |
| impeccable | `C:/Users/hssil/.agents/skills/impeccable/SKILL.md` |
| ui-ux-pro-max | `C:/Users/hssil/.agents/skills/ui-ux-pro-max/SKILL.md` |
| web-design-guidelines | `C:/Users/hssil/.agents/skills/web-design-guidelines/SKILL.md` |

All five are listed by the Skills CLI for Codex. Existing skills were preserved. Start a fresh Codex chat or reload Codex if the current session's skill catalogue has not refreshed.

Anthropic and Vercel were installed from their official repositories through the Skills CLI. UI UX Pro Max was installed using its official CLI, version 2.15.0, with the global Codex target. Impeccable's native installer failed on a missing bundle-verification file (HTTP 404); the official repository was installed successfully through the Skills CLI instead. Its installed skill is version 4.4.0, and the Windows engine reports 0.1.6.

Impeccable's optional automatic edit hooks are off. The master skill selects its workflows on demand. No project-specific product brief was invented during setup; an actual design request will supply the product context.

Verification: the master passed the skill validator; UI UX Pro Max returned relevant typography search results; Impeccable's engine and project-context commands succeeded; its detector returned an overused-font finding for a temporary CSS fixture; the Vercel guidelines source was retrieved successfully. These checks verify installation and basic operation, not the quality of a future website.

An independent routing review exercised eight request scenarios without executing design work: exact recreation, inspiration only, targeted palette/font advice, critique only, a one-property edit, explicit redesign, accessibility review with fixes, and backend-only work. It identified ambiguity around child-workflow checkpoints, review persistence, delegation rules, and narrow UI UX Pro Max searches. Those cases were clarified and rechecked with no remaining routing blocker. The router's local reference links and all four child entry points were also verified.

## Recommendation for this setup

Start with Anthropic's `frontend-design` and Vercel's `web-design-guidelines`, alongside the browser and Mobbin tools already available in this Codex session. Use Impeccable when you want a more structured set of design, critique, and polish commands. UI UX Pro Max is an optional searchable design library.

For a close recreation, the reference should decide the visual design. Inspect its desktop and mobile layouts, typography, spacing, imagery, and interaction states before implementing. Render the local page at matching viewport sizes, compare screenshots, and correct the largest visible differences. For inspiration, specify which characteristics to borrow from each source and which content and branding belong to your project. These are workflow recommendations, not measured rankings.

## Shortlist

### Anthropic frontend-design: best lightweight starting point

The current skill covers subject-specific visual direction, compact color/type/layout plans, responsive implementation, and screenshot self-critique. It explicitly gives a pinned visual brief priority over its aesthetic defaults. That makes it suitable for both original work and reference-led work when the prompt clearly distinguishes them. It does not itself provide a reference library or automated screenshot-difference tooling. [Source skill](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md).

The directory reported about 924.5K installs. GitHub's repository API reported 178,487 stars and a latest push on 24 September 2026 for the entire skills repository, not this individual skill. Popularity supports adoption, not output quality. [Directory](https://skills.sh/anthropics/skills/frontend-design), [repository metadata](https://api.github.com/repos/anthropics/skills).

```powershell
npx skills add anthropics/skills --skill frontend-design -a codex -g
```

### Vercel web-design-guidelines: best companion review

This skill reads UI source files against Vercel's current interface guidelines and reports file/line findings. It covers matters such as accessible controls, focus states, forms, motion, images, and responsive interaction. Use it after implementation; it is not a visual-reference finder or a page generator. Its instructions refer to WebFetch, so Codex must use its available web-reading equivalent. [Source skill](https://github.com/vercel-labs/agent-skills/blob/main/skills/web-design-guidelines/SKILL.md), [guidelines repository](https://github.com/vercel-labs/web-interface-guidelines).

The directory reported about 668.2K installs. The collection had 31,559 GitHub stars and a latest repository push on 28 August 2026. [Directory](https://skills.sh/vercel-labs/agent-skills/web-design-guidelines), [repository metadata](https://api.github.com/repos/vercel-labs/agent-skills).

```powershell
npx skills add vercel-labs/agent-skills --skill web-design-guidelines -a codex -g
```

The Skills CLI documents `--skill`, `-a codex`, and `-g` for selecting a skill, targeting Codex, and installing at user scope. The two commands above were used with `-y` during setup. [CLI documentation](https://github.com/vercel-labs/skills).

### Impeccable: best structured design and refinement toolkit

Impeccable's current repository describes one `impeccable` skill with commands including craft, shape, critique, audit, polish, extract, and harden. It provides a more extensive design workflow and live browser iteration. Its installation and runtime are heavier than a plain Markdown skill: the official installer adds the Codex skill and hooks, and the runtime downloads a platform-specific engine on first use. Provide the existing reference as the visual target explicitly when fidelity is the goal. [Official repository and installation](https://github.com/pbakaus/impeccable).

The directory reported about 294.3K installs. See the companion candidate notes for source-level compatibility and maintenance checks. [Directory](https://skills.sh/pbakaus/impeccable/impeccable).

Official installation, from the project directory:

```powershell
npx impeccable install
```

Then follow its documented Codex hook-trust setup and invoke the skill through Codex, for example `$impeccable init`, `$impeccable critique`, or `$impeccable polish`. Do not treat a design detector score as proof of visual fidelity.

### UI UX Pro Max: optional searchable design guidance

This contains searchable local guidance for styles, palettes, font combinations, UX rules, charts, and framework-specific implementation. Useful when deciding a visual system for a new product. It does not inspect an arbitrary website simply by installing it; reference capture still needs browser tools. The official installer has a Codex target and the search scripts require Python 3. [Source skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/main/.claude/skills/ui-ux-pro-max/SKILL.md), [official installation](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill#installation).

The directory reported about 371.4K installs. GitHub reported 130,735 stars and a latest push on 26 September 2026. [Directory](https://skills.sh/nextlevelbuilder/ui-ux-pro-max-skill/ui-ux-pro-max), [repository metadata](https://api.github.com/repos/nextlevelbuilder/ui-ux-pro-max-skill).

The current official package is `ui-ux-pro-max-cli`; its README warns that older `uipro-cli` packages are stale:

```powershell
npm install -g ui-ux-pro-max-cli
uipro init --ai codex
```

## What you already have

- Browser control can inspect real websites and capture local implementation screenshots.
- Mobbin search tools are exposed for website sections, individual screens, and multi-step flows. Their availability was checked through tool metadata; no live Mobbin search was needed for this research.
- `practical-product-pages` is already installed. Its local instructions cover using references for named design decisions, preserving functional UI, and reviewing desktop/mobile layouts and states.
- The Playwright skill is installed for terminal-driven browser work when applicable. It overlaps with the available browser control rather than replacing visual judgment.

The local product-page skill prefers restrained typography and sentence-case copy. When recreating a specific reference, state that its visual treatment takes priority over these defaults.

## Suggested prompts

### Close recreation

> Recreate [URL] as a working responsive page. Use the reference as the visual target. Inspect it at desktop and mobile widths and record its typography, spacing, section geometry, colors, imagery, and interactions. Preserve those choices during implementation. Compare local screenshots at the same viewport sizes and fix the largest differences. Report any assets or behavior you could not reproduce.

### Inspiration from several websites

> Use [URL A] for typography and spacing, [URL B] for navigation, and [URL C] for the product-gallery interaction. Keep my own branding and content. Show a short design plan explaining the choices, then implement and check desktop and mobile screenshots. Use Mobbin to fill any specific gaps in the flow.

## Limits of this review

Install counts are rounded directory snapshots and may lag repository changes. Stars describe whole repositories. None of these measures proves that one skill will produce a better page. The implementation still needs usable reference access, assets, a running browser, and a clear distinction between recreation and reinterpretation. More overlapping design skills can produce competing aesthetic instructions; begin with a small set and add a tool for a specific gap.
