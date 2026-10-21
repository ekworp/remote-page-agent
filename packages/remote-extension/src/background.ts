export {};

const DEFAULT_BRIDGE_URL = "ws://localhost:9222/agent";
const RECONNECT_ALARM_PREFIX = "remote-page-agent-reconnect:";
type TabConnection = {
  tabId: number;
  pageId: string;
  attempt: number;
  closedByExtension: boolean;
  connected: boolean;
  retryTimer?: number;
};
type BridgeMessage = {
  type?: string;
  id?: string;
  pageId?: string;
  ok?: boolean;
  [key: string]: unknown;
};

const connections = new Map<number, TabConnection>();
let browserIdPromise: Promise<string> | undefined;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  const runtime = chrome.runtime as typeof chrome.runtime & {
    getContexts: (filter: {
      contextTypes: string[];
      documentUrls: string[];
    }) => Promise<Array<{ contextType: string }>>;
  };
  const contexts = await runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS" as chrome.offscreen.Reason],
    justification: "Maintain bridge WebSocket connections independently of the MV3 service worker.",
  });
}

function sendToOffscreen(message) {
  return ensureOffscreenDocument().then(() => chrome.runtime.sendMessage(message));
}

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
      connected: connection.connected,
    })),
  };
}

function closeConnection(tabId) {
  const connection = connections.get(tabId);
  if (!connection) return;
  connection.closedByExtension = true;
  void sendToOffscreen({ type: "disconnect_bridge", tabId }).catch(() => {});
  connections.delete(tabId);
}

async function connectTab(tabId, tab) {
  let connection = connections.get(tabId);
  if (connection?.connected) {
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
    connected: false,
  };
  connections.set(tabId, connection);
  await sendToOffscreen({
    type: "connect_bridge",
    tabId,
    pageId: connection.pageId,
    settings: {
      bridgeUrl: settings.bridgeUrl,
      bridgeToken: settings.bridgeToken,
    },
    browserId: await getBrowserId(),
    url: tab?.url || "about:blank",
    title: tab?.title || "Remote Page",
  });
}

function sendToBridge(tabId, message) {
  void sendToOffscreen({ type: "bridge_message", tabId, message }).catch(() => {});
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
  if (message?.type === "offscreen_bridge_status") {
    const connection = connections.get(message.tabId);
    if (connection) {
      connection.connected = message.status === "connected";
      if (message.status === "connected") {
        connection.attempt = 0;
      }
      if (message.status === "disconnected" && !connection.closedByExtension) {
        connection.attempt += 1;
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(connection.attempt - 1, 6));
        chrome.alarms.create(`${RECONNECT_ALARM_PREFIX}${message.tabId}`, {
          when: Date.now() + delay,
        });
      }
    }
    return false;
  }
  if (message?.type === "offscreen_bridge_message") {
    const connection = connections.get(message.tabId);
    if (!connection) return false;
    const bridgeMessage = message.message as BridgeMessage;
    if (bridgeMessage.type === "hello_ack" && typeof bridgeMessage.pageId === "string") {
      connection.pageId = bridgeMessage.pageId;
      void chrome.tabs.sendMessage(message.tabId, { type: "bridge_ready" }).catch(() => {});
    }
    if (typeof bridgeMessage.id === "string" && typeof bridgeMessage.type === "string") {
      void recordHistory(bridgeMessage.id, bridgeMessage.type, "pending");
    }
    void chrome.tabs
      .sendMessage(message.tabId, { type: "bridge_message", message: bridgeMessage })
      .catch(() => {});
    return false;
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
    connection.connected = false;
    void sendToOffscreen({ type: "disconnect_bridge", tabId }).catch(() => {});
    chrome.tabs
      .get(tabId)
      .then((tab) => connectTab(tabId, tab))
      .catch(() => closeConnection(tabId));
  }
  chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      if (typeof tab.id !== "number" || !/^https?:/i.test(tab.url || "")) continue;
      void connectTab(tab.id, tab).catch(() => {});
    }
  });
});
chrome.runtime.onInstalled.addListener(() => chrome.runtime.openOptionsPage());
