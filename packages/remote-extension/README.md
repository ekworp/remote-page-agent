# Remote Page Agent Extension

This is the Chromium Manifest V3 version of Remote Page Agent.

The background service worker owns one bridge connection per tab. A content
script handles page commands and sends page events back to the worker. This
keeps the bridge connection outside the page and avoids relying on the page's
Content Security Policy.

## Load locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this directory.
4. Open the extension's **Options** page and set the bridge URL and token.

The first version supports page information, DOM summaries, accessibility
snapshots, basic DOM queries, and fixed click/fill operations. More commands
will be added as they are moved from `remote-userscript`.
