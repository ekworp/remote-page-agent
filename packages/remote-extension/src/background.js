const DEFAULT_BRIDGE_URL = "ws://localhost:9222/agent";
const connections = new Map();
let browserIdPromise;

function getBrowserId() {
  if (!browserIdPromise) {
    browserIdPromise = chrome.storage.local.get("browserId").then(async (values) => {
      if (typeof values.browserId === "string" && values.browserId) return values.browserId;
      const browserId = crypto.randomUUID();
      await chrome.storage.local.set({ browserId });
      return browserId;
    });
  }
  return browserIdPromise;
}

async function getSettings() {
  const values = await chrome.storage.local.get({
    bridgeUrl: DEFAULT_BRIDGE_URL,
    bridgeToken: "",
  });
  return {
    bridgeUrl: String(values.bridgeUrl || DEFAULT_BRIDGE_URL).trim(),
    bridgeToken: String(values.bridgeToken || "").trim(),
  };
}

function closeConnection(tabId) {
  const connection = connections.get(tabId);
  if (!connection) return;
  connection.closedByExtension = true;
  connection.socket?.close(1000, "Tab closed");
  connections.delete(tabId);
}

async function connectTab(tabId, tab) {
  let connection = connections.get(tabId);
  if (
    connection?.socket?.readyState === WebSocket.OPEN ||
    connection?.socket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  const settings = await getSettings();
  if (!settings.bridgeUrl) return;
  if (connection?.retryTimer) clearTimeout(connection.retryTimer);
  connection = {
    tabId,
    pageId: connection?.pageId || crypto.randomUUID(),
    attempt: connection?.attempt || 0,
    closedByExtension: false,
  };
  connections.set(tabId, connection);

  const socket = new WebSocket(settings.bridgeUrl);
  connection.socket = socket;
  socket.addEventListener("open", async () => {
    connection.attempt = 0;
    socket.send(
      JSON.stringify({
        type: "hello",
        browserId: await getBrowserId(),
        pageId: connection.pageId,
        token: settings.bridgeToken,
        url: tab?.url || "about:blank",
        title: tab?.title || "Remote Page",
      }),
    );
  });
  socket.addEventListener("message", async (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.type === "hello_ack" && typeof message.pageId === "string") {
      connection.pageId = message.pageId;
    }
    try {
      await chrome.tabs.sendMessage(tabId, { type: "bridge_message", message });
    } catch {
      // The tab can be between documents while navigation is in progress.
    }
  });
  socket.addEventListener("close", () => {
    if (connections.get(tabId)?.socket !== socket || connection.closedByExtension) return;
    connection.attempt += 1;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(connection.attempt - 1, 6));
    connection.retryTimer = setTimeout(() => {
      connection.retryTimer = undefined;
      chrome.tabs
        .get(tabId)
        .then((currentTab) => connectTab(tabId, currentTab))
        .catch(() => closeConnection(tabId));
    }, delay);
  });
}

function sendToBridge(tabId, message) {
  const socket = connections.get(tabId)?.socket;
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") return undefined;

  if (message?.type === "content_ready") {
    chrome.tabs
      .get(tabId)
      .then((tab) => connectTab(tabId, tab))
      .catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "agent_message") {
    sendToBridge(tabId, message.message);
    sendResponse({ ok: true });
    return true;
  }
  return undefined;
});

chrome.tabs.onRemoved.addListener((tabId) => closeConnection(tabId));
chrome.runtime.onInstalled.addListener(() => chrome.runtime.openOptionsPage());
