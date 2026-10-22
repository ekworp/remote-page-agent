export {};

const DEFAULT_BRIDGE_URL = "ws://localhost:9222/agent";
const RECONNECT_ALARM_PREFIX = "remote-page-agent-reconnect:";
const RECONCILE_ALARM = "remote-page-agent-reconcile";
const TEMPORARY_GRANT_TTL_MS = 60_000;
const TEMPORARY_GRANT_IDLE_TTL_MS = 5 * 60_000;
const TEMPORARY_GRANT_MAX_LIFETIME_MS = 30 * 60_000;
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
type StoredConnection = { tabId: number; pageId: string };

const connections = new Map<number, TabConnection>();
let browserIdPromise: Promise<string> | undefined;
let offscreenReady = false;
let offscreenEnsurePromise: Promise<boolean> | undefined;

async function updateActionStatus() {
  const count = Array.from(connections.values()).filter(
    (connection) => connection.connected,
  ).length;
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeConnection =
    typeof activeTab?.id === "number" ? connections.get(activeTab.id) : undefined;
  const badgeText = activeConnection?.connected ? "✓" : activeConnection ? "…" : "";
  const badgeColor = activeConnection?.connected
    ? "#16845b"
    : activeConnection
      ? "#b7791f"
      : "#68758a";
  void chrome.action.setBadgeText({ text: badgeText });
  void chrome.action.setBadgeBackgroundColor({ color: badgeColor });
  void chrome.action.setTitle({
    title: activeConnection?.connected
      ? `网页操盘手：当前页面已连接（共 ${count} 个页面）`
      : activeConnection
        ? "网页操盘手：当前页面连接中"
        : "网页操盘手：当前页面未连接",
  });
}

async function ensureOffscreenDocument() {
  if (offscreenReady) return false;
  if (offscreenEnsurePromise) return offscreenEnsurePromise;
  offscreenEnsurePromise = ensureOffscreenDocumentInternal();
  try {
    return await offscreenEnsurePromise;
  } finally {
    offscreenEnsurePromise = undefined;
  }
}

async function ensureOffscreenDocumentInternal() {
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
  if (contexts.length > 0) {
    offscreenReady = true;
    return false;
  }
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS" as chrome.offscreen.Reason],
      justification:
        "Maintain bridge WebSocket connections independently of the MV3 service worker.",
    });
  } catch (error) {
    // Another concurrent caller may have created it first.
    if (!String(error?.message || error).includes("already exists")) throw error;
  }
  offscreenReady = true;
  return true;
}

function sendToOffscreen(message) {
  return ensureOffscreenDocument()
    .then(() => chrome.runtime.sendMessage(message))
    .catch((error) => {
      offscreenReady = false;
      throw error;
    });
}

function saveStoredConnections() {
  return chrome.storage.local.set({
    storedConnections: Array.from(connections.values()).map(({ tabId, pageId }) => ({
      tabId,
      pageId,
    })),
  });
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
    temporaryGrants: [],
  });
  return {
    bridgeUrl: String(values.bridgeUrl || DEFAULT_BRIDGE_URL).trim(),
    bridgeToken: String(values.bridgeToken || "").trim(),
    whitelistEnabled: Boolean(values.whitelistEnabled),
    whitelistOrigins: Array.isArray(values.whitelistOrigins) ? values.whitelistOrigins : [],
    language: values.language === "zh" || values.language === "en" ? values.language : "auto",
    commandHistoryLimit: Math.max(1, Math.min(200, Number(values.commandHistoryLimit) || 50)),
    temporaryGrants: Array.isArray(values.temporaryGrants) ? values.temporaryGrants : [],
  };
}

function originForUrl(value) {
  try {
    const origin = new URL(value || "").origin;
    return origin === "null" ? "" : origin;
  } catch {
    return "";
  }
}

function validTemporaryGrants(grants) {
  const now = Date.now();
  return grants.filter(
    (grant) =>
      grant &&
      typeof grant.origin === "string" &&
      typeof grant.pageId === "string" &&
      Number.isFinite(grant.expiresAt) &&
      Number.isFinite(grant.maxExpiresAt) &&
      grant.expiresAt > now &&
      grant.maxExpiresAt > now,
  );
}

async function addTemporaryGrant(url, pageId) {
  const origin = originForUrl(url);
  if (!origin || !pageId) return;
  const settings = await getSettings();
  if (!settings.whitelistEnabled || settings.whitelistOrigins.includes(origin)) return;
  const now = Date.now();
  const grants = validTemporaryGrants(settings.temporaryGrants).filter(
    (grant) => grant.pageId !== pageId,
  );
  grants.push({
    origin,
    pageId,
    expiresAt: now + TEMPORARY_GRANT_TTL_MS,
    maxExpiresAt: now + TEMPORARY_GRANT_MAX_LIFETIME_MS,
  });
  await chrome.storage.local.set({ temporaryGrants: grants });
}

async function touchTemporaryGrant(origin, pageId) {
  if (!origin || !pageId) return;
  const settings = await getSettings();
  const now = Date.now();
  let changed = false;
  const grants = validTemporaryGrants(settings.temporaryGrants).map((grant) => {
    if (grant.origin !== origin || grant.pageId !== pageId) return grant;
    changed = true;
    return {
      ...grant,
      expiresAt: Math.min(now + TEMPORARY_GRANT_IDLE_TTL_MS, grant.maxExpiresAt),
    };
  });
  if (changed) await chrome.storage.local.set({ temporaryGrants: grants });
}

async function recordHistory(id, type, status, pageId) {
  if (typeof id !== "string" || !id || typeof type !== "string" || typeof pageId !== "string")
    return;
  const settings = await getSettings();
  const values = await chrome.storage.local.get({ commandHistory: [] });
  const history = Array.isArray(values.commandHistory) ? values.commandHistory : [];
  const existing = history.find((entry) => entry.id === id && entry.pageId === pageId);
  if (existing) {
    existing.status = status;
    existing.timestamp = Date.now();
  } else {
    history.unshift({ id, type, pageId, status, timestamp: Date.now() });
  }
  const pageHistory = history
    .filter((entry) => entry.pageId === pageId)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, settings.commandHistoryLimit);
  const otherHistory = history.filter((entry) => entry.pageId !== pageId);
  await chrome.storage.local.set({
    commandHistory: [...pageHistory, ...otherHistory],
  });
}

async function popupState() {
  const settings = await getSettings();
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeConnection =
    typeof activeTab?.id === "number" ? connections.get(activeTab.id) : undefined;
  const values = await chrome.storage.local.get({ commandHistory: [] });
  return {
    language: settings.language,
    pageId: activeConnection?.pageId || "",
    history:
      activeConnection && Array.isArray(values.commandHistory)
        ? values.commandHistory.filter((entry) => entry.pageId === activeConnection.pageId)
        : [],
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
  void saveStoredConnections();
  updateActionStatus();
}

async function connectTab(tabId, tab, requestedPageId, force = false) {
  let connection = connections.get(tabId);
  const nextPageId =
    typeof requestedPageId === "string" && requestedPageId
      ? requestedPageId
      : connection?.pageId || crypto.randomUUID();
  if (!force && connection?.connected && connection.pageId === nextPageId) {
    void chrome.tabs
      .sendMessage(tabId, { type: "bridge_ready", pageId: connection.pageId })
      .catch(() => {});
    return;
  }
  if (connection?.connected && connection.pageId !== nextPageId) {
    connection.connected = false;
    void sendToOffscreen({ type: "disconnect_bridge", tabId }).catch(() => {});
  }

  const settings = await getSettings();
  if (!settings.bridgeUrl) return;
  if (settings.whitelistEnabled) {
    const origin = originForUrl(tab?.url);
    const temporaryAccess = settings.temporaryGrants.some(
      (grant) =>
        grant.origin === origin && grant.pageId === nextPageId && grant.expiresAt > Date.now(),
    );
    if (!settings.whitelistOrigins.includes(origin) && !temporaryAccess) return;
  }
  if (connection?.retryTimer) clearTimeout(connection.retryTimer);
  await chrome.alarms.clear(`${RECONNECT_ALARM_PREFIX}${tabId}`);
  connection = {
    tabId,
    pageId: nextPageId,
    attempt: connection?.attempt || 0,
    closedByExtension: false,
    connected: false,
  };
  connections.set(tabId, connection);
  void saveStoredConnections();
  updateActionStatus();
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
      connections.get(tabId)?.pageId,
    );
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "popup_state") {
    popupState().then(sendResponse);
    return true;
  }
  if (message?.type === "clear_history") {
    chrome.storage.local
      .get({ commandHistory: [] })
      .then((values) => {
        const history = Array.isArray(values.commandHistory) ? values.commandHistory : [];
        return chrome.storage.local.set({
          commandHistory:
            typeof message.pageId === "string"
              ? history.filter((entry) => entry.pageId !== message.pageId)
              : history,
        });
      })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "reconnect_active") {
    chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then(([tab]) => {
        if (typeof tab?.id !== "number") return { ok: false, error: "No active tab" };
        return connectTab(tab.id, tab, undefined, true).then(() => ({ ok: true }));
      })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "test_bridge") {
    Promise.all([getSettings(), getBrowserId()])
      .then(([settings, browserId]) =>
        sendToOffscreen({
          type: "test_bridge",
          bridgeUrl:
            typeof message.bridgeUrl === "string" ? message.bridgeUrl.trim() : settings.bridgeUrl,
          bridgeToken:
            typeof message.bridgeToken === "string"
              ? message.bridgeToken.trim()
              : settings.bridgeToken,
          browserId,
        }),
      )
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "offscreen_bridge_status") {
    let connection = connections.get(message.tabId);
    if (!connection && typeof message.pageId === "string") {
      connection = {
        tabId: message.tabId,
        pageId: message.pageId,
        attempt: 0,
        closedByExtension: false,
        connected: false,
      };
      connections.set(message.tabId, connection);
    }
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
      updateActionStatus();
    }
    return false;
  }
  if (message?.type === "offscreen_bridge_message") {
    let connection = connections.get(message.tabId);
    if (!connection && typeof message.pageId === "string") {
      connection = {
        tabId: message.tabId,
        pageId: message.pageId,
        attempt: 0,
        closedByExtension: false,
        connected: false,
      };
      connections.set(message.tabId, connection);
    }
    if (!connection) return false;
    const bridgeMessage = message.message as BridgeMessage;
    if (bridgeMessage.type === "hello_ack" && typeof bridgeMessage.pageId === "string") {
      connection.pageId = bridgeMessage.pageId;
      void chrome.tabs
        .sendMessage(message.tabId, { type: "bridge_ready", pageId: connection.pageId })
        .catch(() => {});
    }
    if (typeof bridgeMessage.id === "string" && typeof bridgeMessage.type === "string") {
      void recordHistory(bridgeMessage.id, bridgeMessage.type, "pending", connection.pageId);
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
      .then((tab) => {
        const pageId = typeof message.pageId === "string" ? message.pageId : undefined;
        void touchTemporaryGrant(originForUrl(tab.url), pageId);
        return connectTab(tabId, tab, pageId);
      })
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
      addTemporaryGrant(payload.url, payload.pageId)
        .then(() => chrome.tabs.create({ url: target.href, active: true }))
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
    void chrome.tabs
      .get(tabId)
      .then((tab) => touchTemporaryGrant(originForUrl(tab.url), connections.get(tabId)?.pageId))
      .catch(() => {});
    sendToBridge(tabId, message.message);
    sendResponse({ ok: true });
    return true;
  }
  return undefined;
});

chrome.tabs.onRemoved.addListener((tabId) => closeConnection(tabId));
chrome.tabs.onActivated.addListener(() => updateActionStatus());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status || changeInfo.url) updateActionStatus();
});

async function reconcileConnections() {
  const values = await chrome.storage.local.get({ storedConnections: [] });
  const stored = Array.isArray(values.storedConnections)
    ? values.storedConnections.filter(
        (entry): entry is StoredConnection =>
          Number.isInteger(entry?.tabId) &&
          typeof entry?.pageId === "string" &&
          Boolean(entry.pageId),
      )
    : [];
  const offscreenWasCreated = await ensureOffscreenDocument();
  const tabs = await chrome.tabs.query({});
  const tabsById = new Map(
    tabs.filter((tab) => typeof tab.id === "number").map((tab) => [tab.id as number, tab]),
  );

  for (const entry of stored) {
    const tab = tabsById.get(entry.tabId);
    if (!tab || !/^https?:/i.test(tab.url || "")) continue;
    if (offscreenWasCreated || !connections.has(entry.tabId)) {
      void connectTab(entry.tabId, tab, entry.pageId).catch(() => {});
    }
  }
  for (const [tabId] of connections) {
    if (!tabsById.has(tabId)) closeConnection(tabId);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONCILE_ALARM) {
    void reconcileConnections().catch(() => {});
    return;
  }
  if (!alarm.name.startsWith(RECONNECT_ALARM_PREFIX)) return;
  const tabId = Number(alarm.name.slice(RECONNECT_ALARM_PREFIX.length));
  chrome.tabs
    .get(tabId)
    .then((tab) => connectTab(tabId, tab, undefined))
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
      .then((tab) => connectTab(tabId, tab, undefined))
      .catch(() => closeConnection(tabId));
  }
  chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      if (typeof tab.id !== "number" || !/^https?:/i.test(tab.url || "")) continue;
      void connectTab(tab.id, tab, undefined).catch(() => {});
    }
  });
});
chrome.runtime.onInstalled.addListener(() => chrome.runtime.openOptionsPage());
chrome.alarms.create(RECONCILE_ALARM, { periodInMinutes: 0.5 });
void reconcileConnections().catch(() => {});
updateActionStatus();
