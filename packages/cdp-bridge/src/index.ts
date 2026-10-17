import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const publicHost = process.env.PUBLIC_HOST ?? host;
const browserId = randomUUID();
const pageId = randomUUID();
const sessionId = randomUUID();
let agent: WebSocket | undefined;
let page = { url: "about:blank", title: "Remote Page" };
const clients = new Set<WebSocket>();
const pending = new Map<string, (message: AgentMessage) => void>();

type AgentMessage = {
  id?: string;
  type: string;
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

function json(value: unknown): string {
  return JSON.stringify(value);
}

function targetInfo(): Record<string, unknown> {
  return {
    targetId: pageId,
    type: "page",
    title: page.title,
    url: page.url,
    attached: true,
    canAccessOpener: false,
    browserContextId: browserId,
  };
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(json(value));
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

function requestAgent(type: string, payload: Record<string, unknown> = {}): Promise<AgentMessage> {
  if (!agent || agent.readyState !== agent.OPEN) {
    return Promise.reject(new Error("No userscript is connected"));
  }
  const connectedAgent = agent;
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Userscript command timed out: ${type}`));
    }, 15_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    send(connectedAgent, { id, type, payload });
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
        send(socket, cdpResult(message, { targetInfos: [targetInfo()] }));
        return;
      case "Target.getTargetInfo":
        send(socket, cdpResult(message, { targetInfo: targetInfo() }));
        return;
      case "Target.attachToTarget":
        send(socket, cdpResult(message, { sessionId }));
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
        const result = await requestAgent("eval_safe", { code: expression });
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
        await requestAgent("navigate", { url });
        page = { url, title: page.title };
        send(socket, cdpResult(message, { frameId: pageId }));
        return;
      }
      case "Input.insertText": {
        const text = message.params?.text;
        if (typeof text !== "string") throw new Error("text is required");
        await requestAgent("eval_safe", {
          code: `document.activeElement && (document.activeElement.value = ${JSON.stringify(text)})`,
        });
        send(socket, cdpResult(message, {}));
        return;
      }
      case "Page.getFrameTree":
        send(
          socket,
          cdpResult(message, {
            frameTree: {
              frame: {
                id: pageId,
                url: page.url,
                securityOrigin: new URL(page.url).origin,
                mimeType: "text/html",
              },
            },
          }),
        );
        return;
      default:
        send(socket, cdpError(message, `Unsupported CDP method: ${method}`));
    }
  } catch (error) {
    send(socket, cdpError(message, error instanceof Error ? error.message : String(error)));
  }
}

function handleAgent(socket: WebSocket): void {
  agent = socket;
  socket.on("message", (data) => {
    const message = JSON.parse(String(data)) as AgentMessage;
    if (message.type === "hello") {
      page = { url: String(message.url ?? page.url), title: String(message.title ?? page.title) };
      return;
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
      return;
    }
    if (message.type === "console") {
      for (const client of clients) {
        send(client, {
          method: "Runtime.consoleAPICalled",
          params: {
            type: message.method ?? "log",
            args: [],
            executionContextId: 1,
            timestamp: Date.now(),
          },
        });
      }
    }
  });
  socket.on("close", () => {
    if (agent === socket) agent = undefined;
  });
}

const server = createServer((request, response) => {
  if (request.url === "/json/version") {
    response.setHeader("content-type", "application/json");
    response.end(
      json({
        Browser: "Remote Page Agent",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://${publicHost}:${port}/devtools/browser/${browserId}`,
      }),
    );
    return;
  }
  if (request.url === "/json" || request.url === "/json/list") {
    response.setHeader("content-type", "application/json");
    response.end(
      json([
        {
          id: pageId,
          type: "page",
          title: page.title,
          url: page.url,
          webSocketDebuggerUrl: `ws://${publicHost}:${port}/devtools/page/${pageId}`,
        },
      ]),
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
    if (path === `/devtools/browser/${browserId}` || path === `/devtools/page/${pageId}`) {
      clients.add(client);
      client.on("message", (data) => void handle(client, JSON.parse(String(data)) as CdpMessage));
      client.on("close", () => clients.delete(client));
      return;
    }
    client.close(1008, "Unknown endpoint");
  });
});

server.listen(port, host, () => {
  console.log(`CDP bridge listening on http://${host}:${port}`);
  console.log(`Userscript endpoint: ws://${host}:${port}/agent`);
});
