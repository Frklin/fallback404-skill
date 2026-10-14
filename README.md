# /fallback404

**You built the pages. Let's do the missing ones.**

[![fallback404: you built the pages, let's do the missing ones](assets/hero.png)](https://fallback404-beta.vercel.app)

`/fallback404` is a free skill for your coding agent (Claude Code, Codex, Cursor, OpenCode, Gemini CLI, GitHub Copilot or any other agent that reads [Agent Skills](https://agentskills.io)) that finds the 404, loading and error pages your Next.js app is missing, including 404 pages that wrongly answer HTTP 200, and designs on-brand ones with you on a picker page in your browser. It writes them on a new git branch and never commits.

## Install

In Claude Code:

```bash
/plugin marketplace add Frklin/fallback404-skill
/plugin install fallback404@fallback404
```

On Claude Code 2.1.275 or later, one line does both: `/plugin install fallback404 --marketplace Frklin/fallback404-skill`.

Then, in your Next.js app, ask: *Let's build the /fallback404*.

### Other agents

Codex installs it as a plugin, from the same marketplace:

```bash
codex plugin marketplace add Frklin/fallback404-skill
codex plugin add fallback404@fallback404
```

Cursor, OpenCode, Gemini CLI, GitHub Copilot and any other agent that reads skills: from your Next.js app's folder, run the [`skills` CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add Frklin/fallback404-skill
```

It asks which agents you use, then installs both skills, `fallback404` and the `/404s` shortcut, into `.agents/skills/` in the project (Codex, Cursor, OpenCode, Gemini CLI, GitHub Copilot and most others read it) and links them into the folder of every other agent you picked, `.claude/skills/` for Claude Code included. Add `-g` to install them for your user instead of one project, `-a <agent>` to name the agents, `-y` to skip the questions.

<details>
<summary>No installer? Copy the skills directly.</summary>

```bash
git clone https://github.com/Frklin/fallback404-skill
rsync -a --exclude '.DS_Store' fallback404-skill/skills/ ~/.agents/skills/   # Codex, Cursor, OpenCode, Gemini CLI, Copilot…
rsync -a --exclude '.DS_Store' fallback404-skill/skills/ ~/.claude/skills/   # Claude Code
```

Restart your agent after copying.
</details>

<details>
<summary>Update or remove it.</summary>

```bash
npx skills update fallback404 404s
npx skills remove fallback404 404s

/plugin marketplace update fallback404          # Claude Code
/plugin uninstall fallback404@fallback404

codex plugin marketplace upgrade fallback404    # Codex
codex plugin remove fallback404@fallback404
```

A copied skill is removed by deleting its two folders, `fallback404/` and `404s/`.
</details>

### Agents

Any agent that reads Agent Skills (a `SKILL.md` in a skills folder) and runs shell commands can use it.

| Agent | Install | Tested |
| --- | --- | --- |
| Claude Code | plugin, or `skills` CLI | whole run, picker included |
| OpenCode | `skills` CLI | whole run on a free model: picker, branch, a soft-404 fix, dev and production checks; not the design steps |
| Codex CLI | plugin, or `skills` CLI | plugin and skill install, finds both skills, preflight and scan; not the picker or the write phases |
| Cursor, Gemini CLI, GitHub Copilot and others | `skills` CLI | installs into the folder they read; not run |

`SKILL.md` names its folder `${CLAUDE_SKILL_DIR}`. Claude Code fills that in; other agents are told to use the folder's absolute path.

Opening this repo in an agent also works: `.agents/skills/`, `.claude/skills/` and `.opencode/skills/` each hold a link to `skills/fallback404/`. On Windows, git needs `core.symlinks` (Developer Mode or an admin shell) to check those links out; without it they are plain text files and only that opening-the-repo case is affected, not the installs above.

## Use it

From your Next.js app's folder, in your agent:

```text
/fallback404
```

Or say it in your own words: *add my missing 404 pages*, *fix the soft 404s*, *give /dashboard a loading state*, *redesign my 404 page*. Text after the command goes along too: `/fallback404 fix the soft 404s`. In Claude Code, the shorter `/404s` works as well.

What happens:

1. **Scan.** It reads your App Router tree and finds missing `not-found`, `loading` and `error` files, and dynamic routes that answer 200 for records that don't exist.
2. **Coverage.** A picker page opens in your browser with every 404, loading and error flow of your app, screenshots of your current 404 pages, and a choice per row: create, keep, redesign or fix.
3. **Understand.** While you choose, two agents read what your app does and which of its components render on their own. Every design starts from that brief.
4. **Design.** One step per flow you chose (the 404 at `/`, the 404 at `/products/[id]`, the loading state at `/dashboard`…): two options built from your own components, tokens and words, next to your current page when you have one. You pick, or reject with a note and get a new round.
5. **Review.** After the last pick it lists every file it will create, replace or change, with a diff for each file of yours, and waits for your yes in the chat.
6. **Write.** Files go on a new branch, `fallback404/<date>`: one folder per flow in `components/fallback404/flows/`, thin route files, and one root `not-found` that shows each section its own design.
7. **Check.** It checks the output rules below, type-checks, screenshots every state in light and dark mode and, if you agree, runs a production build to confirm each 404 answers HTTP 404. Nothing is committed: review with `git diff` and commit when you're happy.

## What it makes

Real sites whose 404 page belongs to them: the site's own colors, fonts and components, and one idea from what the site does. This is the bar the skill designs toward on yours.

| [Strike & Ball](https://www.strikeandball.com/) | [Find a Day](https://www.findaday.app/) | [Step by Step](https://step-by-step-kappa.vercel.app/) |
| --- | --- | --- |
| ![Strike & Ball 404: a round with no strikes and no balls](assets/strikeandball-404.png) | ![Find a Day 404: a calendar with one empty slot](assets/findaday-404.png) | ![Step by Step 404: a step that is not there](assets/stepbystep-404.png) |
| A daily number-guessing game. Its 404 is a round with no strikes and no balls. | Pick the day that works for everyone. Its 404 is a calendar with one empty slot. | Instructions drawn as a flow of steps. Its 404 is a step that is not there. |

## What lands on the branch

```text
app/
  global-error.tsx                ← required here; renders its own <html> and <body>
  not-found.tsx                   ← wrapper, imports the router
  error.tsx                       ← wrapper
  loading.tsx                     ← wrapper
  products/[id]/not-found.tsx     ← wrapper, only where a section needs its own
  fallback404-preview/page.tsx    ← every flow on one page, dev only

components/fallback404/
  flows/root-not-found/           ← one folder per flow: NotFound.tsx, copy.ts, flow.css
  flows/products-id-not-found/    ← the section's own 404, from its components
  flows/products-id-loading/      ← Loader.tsx and its copy.ts
  NotFoundRouter.tsx              ← shows each section's own 404 at the root, before first paint
  fallback404.css                 ← role tokens and motion, instead of editing globals.css
  manifest.json                   ← which route uses which flow
```

Only the files you picked are written. Your own `globals.css` and `.gitignore` are never edited.

## How it works

- The skill is a `SKILL.md` playbook plus zero-dependency Node scripts (`scan`, `coverage`, `picker`, `branch`, `write`, `check`, `shoot`…) that run inside your project.
- Two agents read your app while you are on the coverage page: what it does, and which of its components render on their own. One designer agent per flow builds the options, up to three at a time. An agent that cannot run subagents does the same work in order.
- `scan` parses your routes, `proxy.ts` or `middleware.ts` and data helpers with a vendored `@babel/parser` to find missing states and soft 404s.
- Each script prints one JSON line, so a run can be resumed: progress lives in `.fallback404/`, which is kept out of git through `.git/info/exclude`.
- The picker page is a small hosted service the skill talks to: it receives previews and sends back your choice. The files themselves are written locally.
- `check` enforces the output rules before you see the result.

## What leaves your machine

Your source code never does. The picker page gets only screenshots (of the generated pages and of your site's current pages at made-up URLs), titles, one-line descriptions, route paths and file names. Briefs, diffs and the list of changes stay in `.fallback404/`, in your terminal.

## Output rules

Every page it writes follows these, and a checker enforces them before you see the result:

- A 404 answers HTTP 404. Never 200, never a redirect to home.
- Every color comes from a token and works in light and dark mode.
- Illustrations are decorative SVG (`aria-hidden`, ids unique per instance); the message is real HTML text.
- Motion stops under `prefers-reduced-motion`.
- Loaders have `role="status"` or `aria-busy` with a text label, stay small and inlined, and cause no layout shift.

Details: [`skills/fallback404/reference/output-rules.md`](skills/fallback404/reference/output-rules.md).

## Requirements

- A coding agent that reads Agent Skills and runs shell commands: Claude Code, Codex, Cursor, OpenCode, Gemini CLI, GitHub Copilot… (see [Agents](#agents))
- Node.js 20+
- A Next.js App Router app in a git repo (measured on Next.js 16.3 and 16.4)
- Optional: a one-time headless Chromium download (about 105 MB) for screenshots. The skill asks before downloading; without it, everything still runs except the screenshots and the visual check.

## What's in this repo

- `skills/fallback404/`: the skill (`SKILL.md`), its reference notes, the house style (layouts, motion) and the Node scripts it runs
- `skills/404s/`: the `/404s` shortcut, which runs `fallback404` with whatever you type after it
- `.claude-plugin/`: Claude Code plugin manifest and marketplace catalog (Codex reads the same catalog)
- `.codex-plugin/`: Codex plugin manifest
- `plugin.json`: the same manifest in the [Agent Plugins](https://agent-plugins.org) format
- `.agents/`, `.claude/`, `.opencode/`: links to `skills/fallback404/`, so each agent finds the skill when it opens this repo
- `assets/`: images for this README
- `.github/`: issue templates
- `LICENSE`: MIT

## Credits

- [`@babel/parser`](https://github.com/babel/babel/tree/main/packages/babel-parser) 7.29.9, vendored unmodified under its own MIT license (`skills/fallback404/scripts/vendor/`), reads TypeScript and JSX in projects that don't have it installed.
- [Playwright](https://playwright.dev) takes the screenshots and runs the visual check.
- Repo layout and README shape follow [latent-spaces/brag](https://github.com/latent-spaces/brag).

## Contributing

Issues and ideas are welcome: [open an issue](https://github.com/Frklin/fallback404-skill/issues/new/choose). The code is mirrored from a private repo where its tests live, so pull requests are ported over by hand, with credit.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Frklin/fallback404-skill&type=Date)](https://star-history.com/#Frklin/fallback404-skill&Date)

## License

[MIT](LICENSE)
