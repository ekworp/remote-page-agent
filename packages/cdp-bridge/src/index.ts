import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.PORT ?? 9222);
const host = process.env.HOST ?? "127.0.0.1";
const publicHost = process.env.PUBLIC_HOST ?? host;
const backendBrowserId = randomUUID();

type AgentMessage = {
  id?: string;
  type: string;
  browserId?: string;
  pageId?: string;
  url?: string;
  title?: string;
  ok?: boolean;
  result?: unknown;
  error?: { message?: string };
  [key: string]: unknown;
};

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

type PageConnection = {
  browserId: string;
  pageId: string;
  socket: WebSocket;
  url: string;
  title: string;
};

type PendingRequest = {
  pageId: string;
  resolve: (message: AgentMessage) => void;
};

const pages = new Map<string, PageConnection>();
const clients = new Set<WebSocket>();
const pending = new Map<string, PendingRequest>();
const sessions = new Map<string, string>();

function json(value: unknown): string {
  return JSON.stringify(value);
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(json(value));
}

function logConnection(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function cdpResult(message: CdpMessage, result: unknown): Record<string, unknown> {
  return { id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) };
}

function cdpError(message: CdpMessage, text: string): Record<string, unknown> {
  return {
    id: message.id,
    error: { code: -32000, message: text },
    ...(message.sessionId ? { sessionId: message.sessionId } : {}),
  };
}

function pageTarget(page: PageConnection): Record<string, unknown> {
  return {
    targetId: page.pageId,
    type: "page",
    title: page.title,
    url: page.url,
    attached: true,
    canAccessOpener: false,
    browserContextId: page.browserId,
  };
}

function pageForMessage(message: CdpMessage): PageConnection {
  const pageId = message.sessionId ? sessions.get(message.sessionId) : undefined;
  const page = pageId ? pages.get(pageId) : pages.values().next().value;
  if (!page) throw new Error("No userscript page is connected");
  return page;
}

function requestAgent(
  page: PageConnection,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<AgentMessage> {
  if (page.socket.readyState !== page.socket.OPEN) {
    return Promise.reject(new Error(`Page is disconnected: ${page.pageId}`));
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Userscript command timed out: ${type}`));
    }, 15_000);
    pending.set(id, {
      pageId: page.pageId,
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    });
    send(page.socket, { id, type, payload });
  });
}

async function handle(socket: WebSocket, message: CdpMessage): Promise<void> {
  const method = message.method ?? "";
  try {
    switch (method) {
      case "Browser.getVersion":
        send(
          socket,
          cdpResult(message, {
            protocolVersion: "1.3",
            product: "Remote Page Agent/0.1.0",
            revision: "remote-page-agent",
            userAgent: "remote-page-agent",
            jsVersion: "ECMAScript",
          }),
        );
        return;
      case "Target.getTargets":
        send(socket, cdpResult(message, { targetInfos: [...pages.values()].map(pageTarget) }));
        return;
      case "Target.getTargetInfo": {
        const targetId = message.params?.targetId;
        const page = typeof targetId === "string" ? pages.get(targetId) : pageForMessage(message);
        if (!page) throw new Error(`Unknown target: ${String(targetId)}`);
        send(socket, cdpResult(message, { targetInfo: pageTarget(page) }));
        return;
      }
      case "Target.attachToTarget": {
        const targetId = message.params?.targetId;
        if (typeof targetId !== "string" || !pages.has(targetId)) {
          throw new Error(`Unknown target: ${String(targetId)}`);
        }
        const newSessionId = randomUUID();
        sessions.set(newSessionId, targetId);
        send(socket, cdpResult(message, { sessionId: newSessionId }));
        return;
      }
      case "Target.detachFromTarget":
        if (message.sessionId) sessions.delete(message.sessionId);
        send(socket, cdpResult(message, {}));
        return;
      case "Target.setDiscoverTargets":
      case "Target.setAutoAttach":
      case "Target.activateTarget":
      case "Page.enable":
      case "Runtime.enable":
      case "DOM.enable":
      case "Network.enable":
      case "Log.enable":
      case "Performance.enable":
        send(socket, cdpResult(message, {}));
        return;
      case "Runtime.evaluate": {
        const expression = message.params?.expression;
        if (typeof expression !== "string") throw new Error("expression is required");
        const page = pageForMessage(message);
        const result = await requestAgent(page, "eval_safe", { code: expression });
        if (!result.ok) throw new Error(result.error?.message ?? "Evaluation failed");
        send(
          socket,
          cdpResult(message, {
            result: { type: typeof result.result, value: result.result },
          }),
        );
        return;
      }
      case "Page.navigate": {
        const url = message.params?.url;
        if (typeof url !== "string") throw new Error("url is required");
        const page = pageForMessage(message);
        await requestAgent(page, "navigate", { url });
        page.url = url;
        send(socket, cdpResult(message, { frameId: page.pageId }));
        return;
      }
      case "Input.insertText": {
        const text = message.params?.text;
        if (typeof text !== "string") throw new Error("text is required");
        const page = pageForMessage(message);
        await requestAgent(page, "eval_safe", {
          code: `document.activeElement && (document.activeElement.value = ${JSON.stringify(text)})`,
        });
        send(socket, cdpResult(message, {}));
        return;
      }
      case "Page.getFrameTree": {
        const page = pageForMessage(message);
        send(
          socket,
          cdpResult(message, {
            frameTree: {
              frame: {
                id: page.pageId,
                url: page.url,
                securityOrigin: new URL(page.url).origin,
                mimeType: "text/html",
              },
            },
          }),
        );
        return;
      }
      default:
        send(socket, cdpError(message, `Unsupported CDP method: ${method}`));
    }
  } catch (error) {
    send(socket, cdpError(message, error instanceof Error ? error.message : String(error)));
  }
}

function handleAgent(socket: WebSocket): void {
  let page: PageConnection | undefined;
  logConnection("Userscript WebSocket connected");
  socket.on("message", (data) => {
    const message = JSON.parse(String(data)) as AgentMessage;
    if (message.type === "hello") {
      const browserId = message.browserId ?? "unknown-browser";
      const pageId = message.pageId ?? randomUUID();
      page = {
        browserId,
        pageId,
        socket,
        url: message.url ?? "about:blank",
        title: message.title ?? "Remote Page",
      };
      pages.set(pageId, page);
      logConnection(`Page connected: browser=${browserId}, page=${pageId}`);
      return;
    }
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      if (request && request.pageId === page?.pageId) {
        request.resolve(message);
        pending.delete(message.id);
      }
      return;
    }
    if (message.type === "console" && page) {
      for (const client of clients) {
        send(client, {
          method: "Runtime.consoleAPICalled",
          params: {
            type: message.method ?? "log",
            args: [],
            executionContextId: 1,
            timestamp: Date.now(),
            pageId: page.pageId,
          },
        });
      }
    }
  });
  socket.on("close", () => {
    if (page && pages.get(page.pageId)?.socket === socket) {
      pages.delete(page.pageId);
      for (const [id, request] of pending) {
        if (request.pageId === page.pageId) pending.delete(id);
      }
      for (const [id, targetId] of sessions) {
        if (targetId === page.pageId) sessions.delete(id);
      }
      logConnection(`Page disconnected: browser=${page.browserId}, page=${page.pageId}`);
    }
    logConnection("Userscript WebSocket disconnected");
  });
}

const server = createServer((request, response) => {
  if (request.url === "/json/version") {
    response.setHeader("content-type", "application/json");
    response.end(
      json({
        Browser: "Remote Page Agent",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://${publicHost}:${port}/devtools/browser/${backendBrowserId}`,
      }),
    );
    return;
  }
  if (request.url === "/json" || request.url === "/json/list") {
    response.setHeader("content-type", "application/json");
    response.end(
      json(
        [...pages.values()].map((page) => ({
          id: page.pageId,
          type: "page",
          title: page.title,
          url: page.url,
          webSocketDebuggerUrl: `ws://${publicHost}:${port}/devtools/page/${page.pageId}`,
        })),
      ),
    );
    return;
  }
  response.statusCode = 404;
  response.end("Not found");
});

const websocket = new WebSocketServer({ noServer: true });
server.on("upgrade", (request: IncomingMessage, socket, head) => {
  const path = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
  websocket.handleUpgrade(request, socket, head, (client) => {
    if (path === "/agent") {
      handleAgent(client);
      return;
    }
    const isBrowserEndpoint = path === `/devtools/browser/${backendBrowserId}`;
    const isPageEndpoint = path.startsWith("/devtools/page/") && pages.has(path.slice(15));
    if (isBrowserEndpoint || isPageEndpoint) {
      clients.add(client);
      logConnection(`CDP client connected (${path})`);
      client.on("message", (data) => void handle(client, JSON.parse(String(data)) as CdpMessage));
      client.on("close", () => {
        clients.delete(client);
        logConnection(`CDP client disconnected (${path})`);
      });
      return;
    }
    client.close(1008, "Unknown endpoint");
  });
});

server.listen(port, host, () => {
  console.log(`CDP bridge listening on http://${host}:${port}`);
  console.log(`Userscript endpoint: ws://${host}:${port}/agent`);
});

function shutdown(): void {
  for (const client of clients) client.close(1001, "Server shutting down");
  for (const page of pages.values()) page.socket.close(1001, "Server shutting down");
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
