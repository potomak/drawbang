# Agent Workflow — PRs, Screenshots & Local Checks

This doc keeps track of the workflow future agent sessions (Muse / Claude Code) should follow. It is the project-tracked version of the local memory at `project:drawbang-pr-workflow.md`.

## Repo & Env

- **Repo:** `potomak/drawbang` at `Documents/src/drawbang` (default `master`)
- **Node:** installed to `/tmp/node-v22` (`v22.20.0`) via `curl https://nodejs.org/dist/v22.20.0/node-v22.20.0-darwin-arm64.tar.gz` → `tar -xzf ... -C /tmp/node-v22 --strip-components=1`. `brew install node@22` is blocked on `/opt/homebrew` ownership + no `sudo` in agent. Use:
  ```bash
  export PATH="/tmp/node-v22/bin:$PATH"
  ```
  If `/tmp` is cleared, re-extract from `/tmp/node.tar.gz` (48 MB) or re-download.

## Before Every PR

1. **Typecheck (required):** `export PATH="/tmp/node-v22/bin:$PATH" && npm run typecheck` (`tsc -b --noEmit`) must be **zero errors**. Also `npm test` for touched area (818 tests). Do not claim verified without this.
2. **Screenshots (required for UI changes):** embed **directly in PR body**, not just `/tmp` paths. Capture at **320×800, 375×812, 430×900** (small mobile where bugs reproduce).
   - Chromium/WebKit headless is **blocked** in this agent by macOS Seatbelt (`MachPortRendezvousServer: Permission denied (1100)` — see below). Do not use `playwright` chromium in agent.
   - Use **Safari WebDriver** remote: user keeps `safaridriver -p 7055` running in their Terminal (agent cannot background due to `setsid` + no `sudo` for `safaridriver --enable`). Harness template:
     ```js
     import { Builder } from 'selenium-webdriver';
     // vite preview --port 51xx --host 127.0.0.1
     const driver = await new Builder().forBrowser('safari').usingServer('http://127.0.0.1:7055').build();
     await driver.manage().window().setRect({width:320,height:800,x:0,y:0});
     await driver.get('http://127.0.0.1:51xx/draw.html');
     await driver.executeScript(()=>document.documentElement.scrollWidth===window.innerWidth); // hasHorizontalScroll check
     const png = await driver.takeScreenshot(); // → /tmp/draw-safari-320.png
     ```
     Then `muse.read_file` to verify pixels, and embed in PR via `gh pr comment` or by pushing to branch under `.screenshots/` and referencing `https://raw.githubusercontent.com/potomak/drawbang/<branch>/.screenshots/draw-320.png`. Clean up `.screenshots` and `selenium-webdriver` devDep after if not needed.

## Why Chromium Fails Here

- Chromium on macOS uses Mach ports for browser↔GPU/renderer IPC (`com.google.Chrome.MachPortRendezvousServer`). No flag disables it (`--single-process` still needs it).
- `muse.bash` runs in a **Seatbelt** (Sandbox.kext) profile that denies `bootstrap_check_in` for that service → `CHECK(kr == KERN_SUCCESS)` → `SIGTRAP`. `muse.real --disable-sandbox` does not lift the macOS seatbelt. Claude Code's `claude-mcp-browser-bridge` runs outside the seatbelt (via `launchd`), so it works there.

## Backlog (GitHub Issues)

- P0 #246 mobile canvas drag (merged fd85125, PR #255)
- P0 #247 frames toolbar horizontal scroll (PR #256 open, branch `fix/frames-mobile-overflow`)
- P0 #248 reload loses canvas — autosave + beforeunload
- P0 #249 `ingest/drawing-store.ts` missing conditional write race
- P1 #250 orders pagination, #251 JWT httpOnly, #252 CloudFront CacheBehaviors
- P2 #253 shell unification, #254 a11y/perf
- Revenue plan: `docs/revenue-share-plan.md` (PR #245 merged 77a7c27), issue #244

## Git

- `gh` at `/opt/homebrew/bin/gh` logged in as `potomak` (HTTPS). Use full path explicitly. `gh auth setup-git` for credential helper.
- Branches: `fix/mobile-canvas-pointer-capture` (merged), `fix/frames-mobile-overflow` (current).
- Past one-offs installed (and removed): `playwright` browsers (`chromium*`/`webkit`/`firefox`), `selenium-webdriver` (kept only while Safari proof needed). Keep `/tmp/node-v22`.

## Cleanup Rule

Remove one-off installs after proof; keep only `/tmp/node-v22`. Verify before PR as above.
