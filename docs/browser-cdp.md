# Browser CDP verification (agent drives user's Chrome)

The agent cannot launch or keep a browser alive (no `&`/backgrounding,
no `setsid` on macOS). The human launches it; the agent commands it over
CDP on `localhost:9222`. See `scripts/browser-cdp.js` (the driver).

## Launch (human runs this in their own terminal, macOS)

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/drawbang-cdp-profile \
  --no-first-run --no-default-browser-check about:blank
```

Runs alongside a normal Chrome (separate profile). Leave the window open
and tell the agent — it verifies with `curl localhost:9222/json/version`.

## Drive (agent runs these)

```sh
# list tabs (tab ids change on every launch — always re-list)
curl -s http://localhost:9222/json/list
# open a fresh tab for the agent (never touch the user's existing tabs)
bun scripts/browser-cdp.js \
  ws://localhost:9222/devtools/page/<TAB_ID> \
  https://pixel.drawbang.com/v2/gallery/lab /tmp/cdp-shot.png
```

Needs `bun` on PATH (or any WebSocket-capable JS runner — the driver
only uses `WebSocket`, binary file write, and argv, so porting is trivial).

## Safety

- The instance is the user's real profile surface: the agent only ever
  operates on tabs it created via `PUT /json/new`, never existing tabs,
  and never anything logged-in without explicit say-so.
- Port 9222 gives any local process full control of the instance; the
  `--user-data-dir` throwaway profile is intentional. Do not log in there.
