# Remote DevTools Extension

This is the Chromium Manifest V3 version of Remote DevTools.

The background service worker owns one bridge connection per tab. A content
script handles page commands and sends page events back to the worker. This
keeps the bridge connection outside the page and avoids relying on the page's
Content Security Policy.

## Load locally

Build the extension and create its ZIP package:

```bash
pnpm --filter @remote-devtools/remote-extension build
```

Compiled JavaScript and copied extension files are written to `dist/extension/`,
which can be loaded directly as an unpacked extension. The ZIP package is
written alongside it under `dist/` as `remote-devtools-extension-v*.zip`.

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `dist/extension/`.
4. Open the extension's **Options** page and set the bridge URL and token.

The extension supports page information, DOM summaries, accessibility
snapshots, DOM queries, page navigation, fixed click/input operations, origin
whitelists, command history, Console forwarding, and English/Chinese settings.
The Options page supports the Console levels `all`, `warn`, `error`, and `off`;
`warn` is the default and forwards warnings and errors. The popup replaces the
userscript's floating status panel and provides current-page status and manual
reconnect.

Console messages are limited to 50 per 10 seconds and page events to 20 per 10
seconds in the extension, preventing noisy pages from overwhelming the bridge.

The background uses `chrome.storage` for settings and history, `chrome.tabs`
for tab lifecycle and new pages, and `chrome.alarms` for reconnect scheduling.
DOM actions stay in the content script because they must run in the page's
document.

The bridge WebSocket is owned by an MV3 offscreen document rather than the
service worker. This keeps the connection alive when the service worker is
suspended. The offscreen document sends a heartbeat every 20 seconds and
reconnects with exponential backoff; the service worker remains a routing and
lifecycle fallback.
