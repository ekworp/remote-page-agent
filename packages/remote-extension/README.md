# 网页操盘手扩展 | Remote Page Agent Extension

This is the Chromium Manifest V3 version of 网页操盘手 (Remote Page Agent).

The background service worker owns one bridge connection per tab. A content
script handles page commands and sends page events back to the worker. This
keeps the bridge connection outside the page and avoids relying on the page's
Content Security Policy.

## Load locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this directory.
4. Open the extension's **Options** page and set the bridge URL and token.

The extension supports page information, DOM summaries, accessibility
snapshots, DOM queries, page navigation, fixed click/input operations, origin
whitelists, command history, and English/Chinese settings. The popup replaces
the userscript's floating status panel.

The background uses `chrome.storage` for settings and history, `chrome.tabs`
for tab lifecycle and new pages, and `chrome.alarms` for reconnect scheduling.
DOM actions stay in the content script because they must run in the page's
document.
