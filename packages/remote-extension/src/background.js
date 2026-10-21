const DEFAULT_BRIDGE_URL = "ws://localhost:9222/agent";
const RECONNECT_ALARM_PREFIX = "remote-page-agent-reconnect:";
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
    whitelistEnabled: false,
    whitelistOrigins: [],
    language: "auto",
    commandHistoryLimit: 50,
  });
  return {
    bridgeUrl: String(values.bridgeUrl || DEFAULT_BRIDGE_URL).trim(),
    bridgeToken: String(values.bridgeToken || "").trim(),
    whitelistEnabled: Boolean(values.whitelistEnabled),
    whitelistOrigins: Array.isArray(values.whitelistOrigins) ? values.whitelistOrigins : [],
    language: values.language === "zh" || values.language === "en" ? values.language : "auto",
    commandHistoryLimit: Math.max(1, Math.min(200, Number(values.commandHistoryLimit) || 50)),
  };
}

async function recordHistory(id, type, status) {
  if (typeof id !== "string" || !id || typeof type !== "string") return;
  const settings = await getSettings();
  const values = await chrome.storage.local.get({ commandHistory: [] });
  const history = Array.isArray(values.commandHistory) ? values.commandHistory : [];
  const existing = history.find((entry) => entry.id === id);
  if (existing) {
    existing.status = status;
    existing.timestamp = Date.now();
  } else {
    history.unshift({ id, type, status, timestamp: Date.now() });
  }
  await chrome.storage.local.set({
    commandHistory: history.slice(0, settings.commandHistoryLimit),
  });
}

async function popupState() {
  const settings = await getSettings();
  const values = await chrome.storage.local.get({ commandHistory: [] });
  return {
    language: settings.language,
    history: Array.isArray(values.commandHistory) ? values.commandHistory : [],
    connections: Array.from(connections.values()).map((connection) => ({
      tabId: connection.tabId,
      pageId: connection.pageId,
      connected: connection.socket?.readyState === WebSocket.OPEN,
    })),
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
  if (settings.whitelistEnabled) {
    let origin = "";
    try {
      origin = new URL(tab?.url || "").origin;
    } catch {
      return;
    }
    if (!settings.whitelistOrigins.includes(origin)) return;
  }
  if (connection?.retryTimer) clearTimeout(connection.retryTimer);
  await chrome.alarms.clear(`${RECONNECT_ALARM_PREFIX}${tabId}`);
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
      try {
        await chrome.tabs.sendMessage(tabId, { type: "bridge_ready" });
      } catch {
        // The tab can still be loading its content script.
      }
    }
    if (typeof message.id === "string" && typeof message.type === "string") {
      void recordHistory(message.id, message.type, "pending");
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
    chrome.alarms.create(`${RECONNECT_ALARM_PREFIX}${tabId}`, { when: Date.now() + delay });
  });
}

function sendToBridge(tabId, message) {
  const socket = connections.get(tabId)?.socket;
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  if (typeof message?.id === "string" && typeof message?.type === "string") {
    void recordHistory(
      message.id,
      message.type,
      message.ok === true ? "success" : message.ok === false ? "error" : "pending",
    );
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "popup_state") {
    popupState().then(sendResponse);
    return true;
  }
  if (message?.type === "clear_history") {
    chrome.storage.local.set({ commandHistory: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
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
    if (message.message?.type === "open_page") {
      const payload = message.message.payload || {};
      if (typeof payload.url !== "string" || typeof payload.pageId !== "string") {
        sendToBridge(tabId, {
          id: message.message.id,
          type: message.message.type,
          ok: false,
          error: { code: "INVALID_ARGUMENT", message: "url and pageId are required" },
        });
        sendResponse({ ok: true });
        return true;
      }
      const target = new URL(payload.url);
      const originalHash = target.hash.slice(1);
      target.hash = new URLSearchParams({
        "remote-page-agent-page": payload.pageId,
        ...(originalHash ? { "remote-page-agent-original-hash": originalHash } : {}),
      }).toString();
      chrome.tabs
        .create({ url: target.href, active: true })
        .then(() =>
          sendToBridge(tabId, {
            id: message.message.id,
            type: message.message.type,
            ok: true,
            result: { opened: true, pageId: payload.pageId },
          }),
        )
        .catch((error) =>
          sendToBridge(tabId, {
            id: message.message.id,
            type: message.message.type,
            ok: false,
            error: { code: "OPEN_PAGE_FAILED", message: String(error.message || error) },
          }),
        );
      sendResponse({ ok: true });
      return true;
    }
    sendToBridge(tabId, message.message);
    sendResponse({ ok: true });
    return true;
  }
  return undefined;
});

chrome.tabs.onRemoved.addListener((tabId) => closeConnection(tabId));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(RECONNECT_ALARM_PREFIX)) return;
  const tabId = Number(alarm.name.slice(RECONNECT_ALARM_PREFIX.length));
  chrome.tabs
    .get(tabId)
    .then((tab) => connectTab(tabId, tab))
    .catch(() => closeConnection(tabId));
});
chrome.storage.onChanged.addListener((changes) => {
  if (
    !changes.bridgeUrl &&
    !changes.bridgeToken &&
    !changes.whitelistEnabled &&
    !changes.whitelistOrigins
  )
    return;
  for (const [tabId, connection] of connections) {
    connection.socket?.close(1000, "Settings changed");
    chrome.tabs
      .get(tabId)
      .then((tab) => connectTab(tabId, tab))
      .catch(() => closeConnection(tabId));
  }
});
chrome.runtime.onInstalled.addListener(() => chrome.runtime.openOptionsPage());
