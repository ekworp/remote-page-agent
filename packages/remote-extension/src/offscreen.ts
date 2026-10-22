export {};

type BridgeConnection = {
  socket?: WebSocket;
  retryTimer?: number;
  closedByExtension: boolean;
  attempt: number;
  config?: {
    tabId: number;
    pageId: string;
    bridgeUrl: string;
    bridgeToken: string;
    browserId: string;
    url: string;
    title: string;
  };
};

const connections = new Map<number, BridgeConnection>();
const HEARTBEAT_INTERVAL = 20_000;

function notifyBackground(message: unknown) {
  void chrome.runtime.sendMessage(message).catch(() => {});
}

function disconnect(tabId: number) {
  const connection = connections.get(tabId);
  if (!connection) return;
  connection.closedByExtension = true;
  if (connection.retryTimer) clearTimeout(connection.retryTimer);
  connection.socket?.close(1000, "Disconnected by extension");
  connections.delete(tabId);
}

function scheduleReconnect(tabId: number) {
  const connection = connections.get(tabId);
  if (!connection || connection.closedByExtension || connection.retryTimer) return;
  connection.attempt += 1;
  const delay = Math.min(60_000, 1000 * 2 ** Math.min(connection.attempt - 1, 6));
  connection.retryTimer = window.setTimeout(() => {
    connection.retryTimer = undefined;
    if (connection.config) connect(connection.config);
  }, delay);
}

function connect(config: NonNullable<BridgeConnection["config"]>) {
  let connection = connections.get(config.tabId);
  if (!connection) {
    connection = { closedByExtension: false, attempt: 0 };
    connections.set(config.tabId, connection);
  }
  connection.config = config;
  connection.closedByExtension = false;
  if (
    connection.socket?.readyState === WebSocket.OPEN ||
    connection.socket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  const socket = new WebSocket(config.bridgeUrl);
  connection.socket = socket;
  socket.addEventListener("open", () => {
    connection.attempt = 0;
    socket.send(
      JSON.stringify({
        type: "hello",
        browserId: config.browserId,
        pageId: config.pageId,
        token: config.bridgeToken,
        url: config.url,
        title: config.title,
      }),
    );
    notifyBackground({
      type: "offscreen_bridge_status",
      tabId: config.tabId,
      pageId: config.pageId,
      status: "connected",
    });
  });
  socket.addEventListener("message", (event) => {
    try {
      notifyBackground({
        type: "offscreen_bridge_message",
        tabId: config.tabId,
        pageId: config.pageId,
        message: JSON.parse(String(event.data)),
      });
    } catch {
      // Ignore malformed bridge messages.
    }
  });
  socket.addEventListener("close", () => {
    if (connections.get(config.tabId)?.socket !== socket || connection.closedByExtension) return;
    notifyBackground({
      type: "offscreen_bridge_status",
      tabId: config.tabId,
      pageId: config.pageId,
      status: "disconnected",
    });
    scheduleReconnect(config.tabId);
  });
  socket.addEventListener("error", () => {
    // The close event performs the reconnect scheduling.
  });
}

function testBridge(message, sendResponse) {
  const socket = new WebSocket(message.bridgeUrl);
  let finished = false;
  const finish = (response) => {
    if (finished) return;
    finished = true;
    window.clearTimeout(timeout);
    socket.close();
    sendResponse(response);
  };
  const timeout = window.setTimeout(() => {
    finish({ ok: false, error: "Connection timed out" });
  }, 5000);
  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        type: "hello",
        browserId: message.browserId,
        pageId: crypto.randomUUID(),
        token: message.bridgeToken,
        url: "about:blank",
        title: "Bridge test",
      }),
    );
  });
  socket.addEventListener("message", (event) => {
    try {
      const response = JSON.parse(String(event.data));
      if (response.type !== "hello_ack") return;
      finish(
        response.ok === true
          ? { ok: true }
          : { ok: false, error: response.error?.message || "Authentication failed" },
      );
    } catch {
      // Ignore malformed test responses.
    }
  });
  socket.addEventListener("error", () => {
    finish({ ok: false, error: "Unable to connect" });
  });
}

setInterval(() => {
  for (const connection of connections.values()) {
    if (connection.socket?.readyState === WebSocket.OPEN) {
      connection.socket.send(JSON.stringify({ type: "ping" }));
    }
  }
}, HEARTBEAT_INTERVAL);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "test_bridge") {
    testBridge(message, sendResponse);
    return true;
  }
  if (message?.type === "connect_bridge") {
    disconnect(message.tabId);
    connect({
      tabId: message.tabId,
      pageId: message.pageId,
      bridgeUrl: message.settings.bridgeUrl,
      bridgeToken: message.settings.bridgeToken,
      browserId: message.browserId,
      url: message.url,
      title: message.title,
    });
  }
  if (message?.type === "bridge_message") {
    const socket = connections.get(message.tabId)?.socket;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message.message));
  }
  if (message?.type === "disconnect_bridge") disconnect(message.tabId);
});
