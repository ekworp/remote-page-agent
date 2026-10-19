import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { type WebSocket, WebSocketServer } from "ws";

function loadDotEnv(): Record<string, string> {
  const candidates = [
    process.env.REMOTE_AGENT_ENV_FILE,
    `${process.cwd()}/.env`,
    `${process.cwd()}/packages/cdp-bridge/.env`,
  ].filter((value): value is string => Boolean(value));
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

const dotEnv = loadDotEnv();
const port = Number(process.env.PORT ?? 9222);
const host = process.env.HOST ?? "127.0.0.1";
const publicHost = process.env.PUBLIC_HOST ?? host;
const publicProtocol = process.env.PUBLIC_PROTOCOL ?? "ws";
const publicOrigin = (
  process.env.PUBLIC_ORIGIN ?? `${publicProtocol}://${publicHost}:${port}`
).replace(/\/$/, "");
const require = createRequire(import.meta.url);
const appVersion = (require("../package.json") as { version: string }).version;
const backendBrowserId = randomUUID();
const remoteAgentToken = process.env.REMOTE_AGENT_TOKEN ?? dotEnv.REMOTE_AGENT_TOKEN ?? "";

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const connectionAttemptWindowMs = positiveNumber(
  process.env.REMOTE_AGENT_CONNECTION_WINDOW_MS ?? dotEnv.REMOTE_AGENT_CONNECTION_WINDOW_MS,
  60_000,
);
const maxConnectionAttempts = positiveNumber(
  process.env.REMOTE_AGENT_MAX_CONNECTION_ATTEMPTS ?? dotEnv.REMOTE_AGENT_MAX_CONNECTION_ATTEMPTS,
  30,
);
const connectionAttempts = new Map<string, number[]>();

type AgentMessage = {
  id?: string;
  type: string;
  browserId?: string;
  pageId?: string;
  url?: string;
  title?: string;
  token?: string;
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

type CdpArgument = {
  objectId?: string;
  value?: unknown;
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
  type: string;
  interruptible: boolean;
  resolve: (message: AgentMessage) => void;
};

const pages = new Map<string, PageConnection>();
const clients = new Set<WebSocket>();
const pending = new Map<string, PendingRequest>();
const sessions = new Map<string, string>();
const functionHandles = new Map<string, string>();
const domHandles = new Map<string, number>();
const pollerHandles = new Set<string>();
const pollerResults = new Map<string, boolean>();
const fakeObjectHandles = new Set<string>();
const executionContextIds = new Map<string, Map<string, number>>();
const sessionOwners = new Map<string, WebSocket>();
const autoAttachClients = new Set<WebSocket>();
const autoAttachedTargetsByClient = new Map<WebSocket, Set<string>>();
const discoveredTargetsByClient = new Map<WebSocket, Set<string>>();
const pageWaiters = new Map<string, Array<(page: PageConnection) => void>>();
let nextExecutionContextId = 1;
const cdpDebug = process.env.CDP_DEBUG === "1" || process.env.CDP_DEBUG === "true";
const pageReconnectGraceMs = Number(process.env.PAGE_RECONNECT_GRACE_MS ?? 10_000);
const reconnectTimers = new Map<string, NodeJS.Timeout>();

function publicUrl(path: string): string {
  return `${publicOrigin}${path}`;
}

function clientAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function allowAgentConnection(request: IncomingMessage): boolean {
  const now = Date.now();
  const address = clientAddress(request);
  const recent = (connectionAttempts.get(address) ?? []).filter(
    (timestamp) => now - timestamp < connectionAttemptWindowMs,
  );
  if (recent.length >= maxConnectionAttempts) {
    connectionAttempts.set(address, recent);
    return false;
  }
  recent.push(now);
  connectionAttempts.set(address, recent);
  return true;
}

function waitForPage(pageId: string): Promise<PageConnection> {
  const page = pages.get(pageId);
  if (page) return Promise.resolve(page);
  return new Promise((resolve, reject) => {
    const waiter = (connectedPage: PageConnection): void => {
      clearTimeout(timer);
      resolve(connectedPage);
    };
    const timer = setTimeout(() => {
      const waiters = pageWaiters.get(pageId) ?? [];
      pageWaiters.set(
        pageId,
        waiters.filter((candidate) => candidate !== waiter),
      );
      reject(new Error(`New page did not connect: ${pageId}`));
    }, 10_000);
    const waiters = pageWaiters.get(pageId) ?? [];
    waiters.push(waiter);
    pageWaiters.set(pageId, waiters);
  });
}

function resolvePageWaiters(page: PageConnection): void {
  const waiters = pageWaiters.get(page.pageId);
  if (!waiters) return;
  pageWaiters.delete(page.pageId);
  for (const waiter of waiters) waiter(page);
}

function broadcast(value: unknown): void {
  for (const client of clients) send(client, value);
}

function broadcastPageEvent(pageId: string, method: string, params: Record<string, unknown>): void {
  for (const client of clients) {
    for (const [sessionId, sessionPageId] of sessions) {
      if (sessionPageId === pageId) send(client, cdpEvent(method, params, sessionId));
    }
  }
}

function markTargetCreated(socket: WebSocket, page: PageConnection): boolean {
  let discovered = discoveredTargetsByClient.get(socket);
  if (!discovered) {
    discovered = new Set();
    discoveredTargetsByClient.set(socket, discovered);
  }
  if (discovered.has(page.pageId)) return false;
  discovered.add(page.pageId);
  send(socket, cdpEvent("Target.targetCreated", { targetInfo: pageTarget(page) }));
  return true;
}

function sendCurrentTargets(socket: WebSocket): void {
  for (const page of pages.values()) markTargetCreated(socket, page);
}

function attachPage(socket: WebSocket, page: PageConnection): string {
  let attached = autoAttachedTargetsByClient.get(socket);
  if (!attached) {
    attached = new Set();
    autoAttachedTargetsByClient.set(socket, attached);
  }
  if (attached.has(page.pageId)) {
    return "";
  }
  attached.add(page.pageId);
  const sessionId = randomUUID();
  sessions.set(sessionId, page.pageId);
  sessionOwners.set(sessionId, socket);
  send(
    socket,
    cdpEvent("Target.attachedToTarget", {
      sessionId,
      targetInfo: { ...pageTarget(page), attached: true },
      waitingForDebugger: false,
    }),
  );
  return sessionId;
}

function detachPageSessions(pageId: string): void {
  for (const [sessionId, sessionPageId] of sessions) {
    if (sessionPageId !== pageId) continue;
    const owner = sessionOwners.get(sessionId);
    if (owner && owner.readyState === owner.OPEN) {
      send(
        owner,
        cdpEvent("Target.detachedFromTarget", {
          sessionId,
          targetId: pageId,
        }),
      );
    }
    sessions.delete(sessionId);
    sessionOwners.delete(sessionId);
    executionContextIds.delete(sessionId);
  }
}

function notifyNewPage(page: PageConnection): void {
  for (const client of clients) {
    if (client.readyState === client.OPEN) markTargetCreated(client, page);
  }
  for (const client of autoAttachClients) {
    if (client.readyState !== client.OPEN) {
      autoAttachClients.delete(client);
      continue;
    }
    attachPage(client, page);
  }
}

function notifyPageUpdated(page: PageConnection): void {
  broadcast(cdpEvent("Target.targetInfoChanged", { targetInfo: pageTarget(page) }));
}

function destroyPage(pageId: string): void {
  const page = pages.get(pageId);
  if (!page) return;
  detachPageSessions(pageId);
  pages.delete(pageId);
  reconnectTimers.delete(pageId);
  for (const [client, discovered] of discoveredTargetsByClient) {
    discovered.delete(pageId);
    if (client.readyState !== client.OPEN) discoveredTargetsByClient.delete(client);
  }
  for (const [client, attached] of autoAttachedTargetsByClient) {
    attached.delete(pageId);
    if (client.readyState !== client.OPEN) autoAttachedTargetsByClient.delete(client);
  }
  broadcast(cdpEvent("Target.targetDestroyed", { targetId: pageId }));
  logConnection(`Page disconnected: browser=${page.browserId}, page=${pageId}`);
}

function summarizeFunctionDeclaration(source: string): string {
  const normalized = source.replace(/\s+/g, " ").trim();
  return `${normalized.slice(0, 500)}${normalized.length > 500 ? "…" : ""}`;
}

function logCdp(direction: "recv" | "send", value: unknown): void {
  if (!cdpDebug || typeof value !== "object" || value === null) return;
  const message = value as CdpMessage & {
    method?: string;
    id?: number;
    error?: unknown;
    result?: Record<string, unknown>;
  };
  if (message.method) {
    const params = message.params ?? {};
    const details: string[] = [];
    if (message.sessionId) details.push(`session=${message.sessionId}`);
    if (params.objectId !== undefined) details.push(`objectId=${String(params.objectId)}`);
    if (params.backendNodeId !== undefined)
      details.push(`backendNodeId=${String(params.backendNodeId)}`);
    if (params.nodeId !== undefined) details.push(`nodeId=${String(params.nodeId)}`);
    if (params.executionContextId !== undefined)
      details.push(`executionContextId=${String(params.executionContextId)}`);
    if (message.method === "Runtime.callFunctionOn") {
      if (typeof params.functionDeclaration === "string") {
        details.push(`functionLength=${params.functionDeclaration.length}`);
        details.push(`function=${summarizeFunctionDeclaration(params.functionDeclaration)}`);
      }
      const args = Array.isArray(params.arguments) ? params.arguments : [];
      details.push(
        `arguments=[${args
          .map((argument) => {
            const item = argument as CdpArgument & { unserializableValue?: string };
            if (typeof item.objectId === "string") return `object:${item.objectId}`;
            if (item.unserializableValue) return `unserializable:${item.unserializableValue}`;
            return `value:${item.value === null ? "null" : typeof item.value}`;
          })
          .join(", ")}]`,
      );
    }
    if (message.method === "Runtime.evaluate" && typeof params.expression === "string") {
      details.push(`expressionLength=${params.expression.length}`);
    }
    console.log(
      `[cdp ${direction}] ${message.method}${details.length ? ` ${details.join(" ")}` : ""}`,
    );
    return;
  }
  if (message.error) {
    console.log(`[cdp ${direction}] error id=${message.id}`);
    return;
  }
  if (message.result) {
    console.log(
      `[cdp ${direction}] response id=${message.id} keys=${Object.keys(message.result).join(",")}`,
    );
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function logDomDebug(message: string, details?: unknown): void {
  if (!cdpDebug) return;
  console.log(`[dom] ${message}${details === undefined ? "" : ` ${json(details)}`}`);
}

function summarizeRect(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const rect = value as Record<string, unknown>;
  const keys = ["x", "y", "width", "height", "top", "left", "right", "bottom"];
  const summary: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof rect[key] === "number") summary[key] = Math.round((rect[key] as number) * 100) / 100;
  }
  return summary;
}

function summarizeDomResult(operation: string, value: unknown): unknown {
  if (operation === "client_rects" && Array.isArray(value)) {
    return {
      count: value.length,
      rects: value.slice(0, 4).map(summarizeRect),
    };
  }
  if (operation === "stable_rects" && Array.isArray(value)) {
    return value.map(summarizeRect);
  }
  if (operation === "scroll_into_view" && typeof value === "object" && value !== null) {
    const item = value as Record<string, unknown>;
    return { ...item, rect: summarizeRect(item.rect) };
  }
  return value;
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState === socket.OPEN) {
    logCdp("send", value);
    socket.send(json(value));
  }
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

function rectToQuad(value: { x: number; y: number; width: number; height: number }): number[] {
  return [
    value.x,
    value.y,
    value.x + value.width,
    value.y,
    value.x + value.width,
    value.y + value.height,
    value.x,
    value.y + value.height,
  ];
}

/**
 * CDP events emitted for a flattened session must carry the top-level
 * sessionId. Without it Puppeteer delivers the event to the browser
 * connection instead of the page session, so Runtime.executionContextCreated
 * is lost and every evaluation waits for a context until it times out.
 */
function cdpEvent(
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Record<string, unknown> {
  return { method, params, ...(sessionId ? { sessionId } : {}) };
}

function pageOrigin(page: PageConnection): string {
  try {
    return new URL(page.url).origin;
  } catch {
    return "null";
  }
}

function frameTree(page: PageConnection): Record<string, unknown> {
  return {
    frame: {
      id: page.pageId,
      loaderId: page.pageId,
      url: page.url,
      domainAndRegistry: "",
      securityOrigin: pageOrigin(page),
      mimeType: "text/html",
      secureContextType: "Secure",
      crossOriginIsolatedContextType: "NotIsolated",
      gatedAPIFeatures: [],
      adFrameStatus: { adFrameType: "none" },
    },
  };
}

function executionContextId(sessionId: string | undefined, worldName: string): number {
  const sessionKey = sessionId ?? "root";
  let worlds = executionContextIds.get(sessionKey);
  if (!worlds) {
    worlds = new Map();
    executionContextIds.set(sessionKey, worlds);
  }
  const existing = worlds.get(worldName);
  if (existing !== undefined) return existing;
  const id = nextExecutionContextId++;
  worlds.set(worldName, id);
  return id;
}

function executionContextEvent(
  page: PageConnection,
  sessionId: string | undefined,
  worldName: string,
): Record<string, unknown> {
  return cdpEvent(
    "Runtime.executionContextCreated",
    {
      context: {
        id: executionContextId(sessionId, worldName),
        origin: pageOrigin(page),
        name: worldName,
        auxData: {
          frameId: page.pageId,
          isDefault: worldName === "",
          type: worldName === "" ? "default" : "isolated",
        },
      },
    },
    sessionId,
  );
}

function looksLikeFunctionExpression(expression: string): boolean {
  const trimmed = expression
    .trim()
    .replace(/^\(([\s\S]*)\)$/, "$1")
    .trim();
  if (/^(async\s+)?function\b/.test(trimmed)) return true;
  return /^(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(trimmed);
}

function remoteObjectForResult(result: AgentMessage): Record<string, unknown> {
  const type = typeof result.resultType === "string" ? result.resultType : typeof result.result;
  if (type === "function") {
    const source =
      typeof result.functionSource === "string"
        ? result.functionSource
        : typeof result.result === "string"
          ? result.result
          : undefined;
    if (source) {
      const objectId = randomUUID();
      functionHandles.set(objectId, source);
      return { type: "function", objectId, description: source };
    }
    return { type: "function" };
  }
  if (type === "undefined") return { type: "undefined" };
  if (result.result === null) return { type: "object", subtype: "null", value: null };
  if (type === "object") return { type: "object", value: result.result };
  return { type, value: result.result };
}

function pageTarget(page: PageConnection): Record<string, unknown> {
  return {
    targetId: page.pageId,
    type: "page",
    title: page.title,
    url: page.url,
    attached: false,
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
  options: { interruptible?: boolean } = {},
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
      type,
      interruptible: options.interruptible ?? false,
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    });
    send(page.socket, { id, type, payload });
  });
}

function numberParam(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function backendNodeIdFromParams(message: CdpMessage): number | undefined {
  const direct = numberParam(message.params?.backendNodeId ?? message.params?.nodeId);
  if (direct !== undefined) return direct;
  const objectId = message.params?.objectId;
  if (typeof objectId === "string") return domHandles.get(objectId);
  return undefined;
}

function domHandleForCall(
  message: CdpMessage,
  argumentsList: CdpArgument[],
): { objectId: string; backendNodeId: number } | undefined {
  const objectId = message.params?.objectId;
  if (typeof objectId === "string" && domHandles.has(objectId)) {
    return { objectId, backendNodeId: domHandles.get(objectId) as number };
  }
  if (typeof objectId === "string") {
    const parsed = /^dom:(\d+):/.exec(objectId);
    if (parsed) return { objectId, backendNodeId: Number(parsed[1]) };
  }
  for (const argument of argumentsList) {
    if (typeof argument.objectId === "string" && domHandles.has(argument.objectId)) {
      return {
        objectId: argument.objectId,
        backendNodeId: domHandles.get(argument.objectId) as number,
      };
    }
    if (typeof argument.objectId === "string") {
      const parsed = /^dom:(\d+):/.exec(argument.objectId);
      if (parsed) return { objectId: argument.objectId, backendNodeId: Number(parsed[1]) };
    }
  }
  return undefined;
}

function pollerObjectIdForCall(
  message: CdpMessage,
  argumentsList: CdpArgument[],
): string | undefined {
  const objectId = message.params?.objectId;
  if (typeof objectId === "string" && pollerHandles.has(objectId)) return objectId;
  for (const argument of argumentsList) {
    if (typeof argument.objectId === "string" && pollerHandles.has(argument.objectId)) {
      return argument.objectId;
    }
  }
  return undefined;
}

type DomNodeInfo = {
  localName: string;
  attributes: Map<string, string>;
};

async function getDomNodeInfo(
  page: PageConnection,
  backendNodeId: number,
): Promise<DomNodeInfo | undefined> {
  const result = await requestAgent(page, "get_dom_node", { backendNodeId, depth: 0 });
  if (!result.ok) return undefined;
  const node = result.result as { localName?: string; nodeName?: string; attributes?: unknown[] };
  const attributes = new Map<string, string>();
  if (Array.isArray(node.attributes)) {
    for (let index = 0; index + 1 < node.attributes.length; index += 2) {
      attributes.set(String(node.attributes[index]), String(node.attributes[index + 1]));
    }
  }
  return {
    localName: (node.localName ?? node.nodeName ?? "").toLowerCase(),
    attributes,
  };
}

function inputKindFromNode(node: DomNodeInfo): string {
  const type = (node.attributes.get("type") ?? "text").toLowerCase();
  if (node.localName === "select") return "select";
  if (node.localName === "textarea") return "typeable-input";
  if (node.localName === "input") {
    if (type === "checkbox" || type === "radio") return "checkable-input";
    if (["text", "url", "tel", "search", "password", "number", "email"].includes(type)) {
      return "typeable-input";
    }
    return "other-input";
  }
  const role = node.attributes.get("role");
  if (role === "checkbox" || role === "radio" || role === "switch") return "checkable-input";
  const contenteditable = node.attributes.get("contenteditable");
  if (contenteditable === "true" || contenteditable === "") return "contenteditable";
  return "unknown";
}

function isCheckableNode(node: DomNodeInfo): boolean {
  const type = (node.attributes.get("type") ?? "").toLowerCase();
  if (node.localName === "input" && (type === "checkbox" || type === "radio")) return true;
  const role = node.attributes.get("role");
  return role === "checkbox" || role === "radio" || role === "switch";
}

async function getEnabledOperation(
  page: PageConnection,
  backendNodeId: number,
): Promise<Record<string, unknown>> {
  return domOperationWithFallback(page, backendNodeId, "get_enabled", {}, async () => {
    const node = await getDomNodeInfo(page, backendNodeId);
    const disabled =
      node !== undefined &&
      (node.attributes.has("disabled") || node.attributes.get("aria-disabled") === "true");
    return { type: "boolean", value: !disabled };
  });
}

async function inputKindOperation(
  page: PageConnection,
  backendNodeId: number,
): Promise<Record<string, unknown>> {
  return domOperationWithFallback(page, backendNodeId, "get_input_kind", {}, async () => {
    const node = await getDomNodeInfo(page, backendNodeId);
    return { type: "string", value: node ? inputKindFromNode(node) : "unknown" };
  });
}

async function isCheckableOperation(
  page: PageConnection,
  backendNodeId: number,
): Promise<Record<string, unknown>> {
  return domOperationWithFallback(page, backendNodeId, "is_checkable", {}, async () => {
    const node = await getDomNodeInfo(page, backendNodeId);
    return { type: "boolean", value: node ? isCheckableNode(node) : false };
  });
}

async function enabledOperation(
  page: PageConnection,
  backendNodeId: number,
): Promise<Record<string, unknown>> {
  const node = await getDomNodeInfo(page, backendNodeId);
  const disabled =
    node?.attributes.has("disabled") || node?.attributes.get("aria-disabled") === "true";
  return { type: "boolean", value: !disabled };
}

async function fillOperation(
  page: PageConnection,
  backendNodeId: number,
  value: string | boolean | string[],
): Promise<Record<string, unknown>> {
  return domOperationWithFallback(page, backendNodeId, "fill", { value }, () => {
    // Older userscript builds only implement set_value. Keep them working for
    // basic input/textarea/select fills.
    return domOperation(page, backendNodeId, "set_value", { value });
  });
}

async function selectOptionOperation(
  page: PageConnection,
  backendNodeId: number,
  values: string[],
): Promise<Record<string, unknown>> {
  return domOperationWithFallback(page, backendNodeId, "select_option", { values }, () => {
    return domOperation(page, backendNodeId, "set_value", { value: values[0] ?? "" });
  });
}

async function domOperationWithFallback(
  page: PageConnection,
  backendNodeId: number,
  operation: string,
  payload: Record<string, unknown> = {},
  fallback: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    return await domOperation(page, backendNodeId, operation, payload);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Unsupported DOM operation")) {
      throw error;
    }
    return fallback();
  }
}

async function domOperation(
  page: PageConnection,
  backendNodeId: number,
  operation: string,
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await requestAgent(
    page,
    "dom_operation",
    {
      backendNodeId,
      operation,
      ...payload,
    },
    { interruptible: operation === "click" },
  );
  if (!result.ok) {
    logDomDebug(`${operation} failed`, { backendNodeId, error: result.error?.message });
    throw new Error(result.error?.message ?? `DOM operation failed: ${operation}`);
  }
  const sensitiveOperations = new Set([
    "attributes",
    "outer_html",
    "fill",
    "set_value",
    "get_value",
    "insert_text",
    "inspect_element",
  ]);
  if (!sensitiveOperations.has(operation)) {
    logDomDebug(
      `${operation} backend=${backendNodeId}`,
      summarizeDomResult(operation, result.result),
    );
  }
  return remoteObjectForResult(result);
}

/**
 * Puppeteer represents DOM element arguments as CDP object handles. It never
 * assigns the element to `callFunctionOn.objectId`; instead it passes it as
 * the first argument. Translate the small set of DOM operations Puppeteer
 * needs into fixed userscript commands instead of evaluating the function.
 */
async function tryHandleDomCall(
  message: CdpMessage,
  page: PageConnection,
  functionDeclaration: string,
  argumentsList: CdpArgument[],
): Promise<Record<string, unknown> | undefined> {
  const argumentValues = argumentsList
    .filter((argument) => !argument.objectId)
    .map((argument) => argument.value);
  const domHandle = domHandleForCall(message, argumentsList);

  if (/RAFPoller|IntervalPoller|MutationPoller/.test(functionDeclaration)) {
    const objectId = `poller:${randomUUID()}`;
    pollerHandles.add(objectId);
    const predicate = argumentValues.find((value) => typeof value === "string");
    let enabled = true;
    if (domHandle && typeof predicate === "string" && /disabled/i.test(predicate)) {
      const state = await getEnabledOperation(page, domHandle.backendNodeId);
      enabled = state.value === true;
    }
    pollerResults.set(objectId, enabled);
    return { type: "object", className: "Object", objectId, description: "Poller" };
  }

  const pollerObjectId = pollerObjectIdForCall(message, argumentsList);
  if (pollerObjectId) {
    const enabled = pollerResults.get(pollerObjectId) ?? true;
    if (/\.result\s*\(/.test(functionDeclaration)) return { type: "boolean", value: enabled };
    return { type: "undefined" };
  }

  if (/function addPageBinding/.test(functionDeclaration)) {
    // Puppeteer's binding shim is not needed by the fixed DOM commands.
    return { type: "undefined" };
  }

  if (/documentWidth|documentHeight/.test(functionDeclaration)) {
    return domOperation(page, 0, "document_size");
  }

  if (!domHandle) return undefined;
  const backendNodeId = domHandle.backendNodeId;
  const textOrBooleanValue = argumentValues.find(
    (value) => typeof value === "string" || typeof value === "boolean",
  );

  // McpPage.fillFormElements() checks whether the element is a checkbox/radio
  // before deciding between locator.fill() and the boolean toggle path.
  if (
    /instanceof HTMLInputElement/.test(functionDeclaration) &&
    /checkbox/.test(functionDeclaration) &&
    /radio/.test(functionDeclaration) &&
    /getAttribute\(['"]role['"]\)/.test(functionDeclaration) &&
    /switch/.test(functionDeclaration) &&
    !/HTMLSelectElement|HTMLTextAreaElement|isContentEditable/.test(functionDeclaration)
  ) {
    return isCheckableOperation(page, backendNodeId);
  }

  // Locator.fill() first probes the element type with a function that returns
  // "typeable-input" / "checkable-input" / "select" / "contenteditable".
  if (
    /instanceof HTMLSelectElement/.test(functionDeclaration) &&
    /isContentEditable/.test(functionDeclaration) &&
    /return\s+['"]/.test(functionDeclaration)
  ) {
    return inputKindOperation(page, backendNodeId);
  }

  // Locator.fill() on a <select> evaluates the options directly.
  const stringArrayValue = argumentValues.find(
    (value) => Array.isArray(value) && value.every((item) => typeof item === "string"),
  );
  if (
    stringArrayValue !== undefined &&
    /option\.selected|selectedValues|HTMLSelectElement/.test(functionDeclaration)
  ) {
    return selectOptionOperation(page, backendNodeId, stringArrayValue as string[]);
  }

  // Checkbox/radio actionability helper.
  if (/indeterminate/.test(functionDeclaration) && /aria-checked/.test(functionDeclaration)) {
    return domOperation(page, backendNodeId, "get_checked");
  }

  // Locator actionability probes disabled controls before clicking. Resolve
  // that fixed property query through DOM attributes so generic cards and
  // framework-managed containers do not time out in the poller.
  if (/\.disabled\b|aria-disabled/.test(functionDeclaration)) {
    return enabledOperation(page, backendNodeId);
  }

  // Short text fill (< typingThreshold): Puppeteer computes the text that is
  // still missing and then calls handle.type(). We set the final value in one
  // fixed operation and return an empty suffix so Puppeteer does not re-type it.
  if (
    textOrBooleanValue !== undefined &&
    /startsWith/.test(functionDeclaration) &&
    /substring/.test(functionDeclaration) &&
    /isContentEditable|\.value/.test(functionDeclaration)
  ) {
    await fillOperation(page, backendNodeId, textOrBooleanValue);
    return { type: "string", value: "" };
  }

  // fillDirectly() for long values and non-standard input types.
  if (
    textOrBooleanValue !== undefined &&
    /(\.value\s*=|\.innerText\s*=)/.test(functionDeclaration) &&
    /dispatchEvent|new Event|InputEvent/.test(functionDeclaration)
  ) {
    await fillOperation(page, backendNodeId, textOrBooleanValue);
    return { type: "undefined" };
  }

  // Existing explicit value setter support (kept for compatibility).
  if (
    textOrBooleanValue !== undefined &&
    /\.value\s*=|setRangeText|setSelectionRange|checked\s*=|setValue|InputEvent|inputType/.test(
      functionDeclaration,
    ) &&
    !/getProperty|propertyDescriptor|startsWith/.test(functionDeclaration)
  ) {
    await fillOperation(page, backendNodeId, textOrBooleanValue);
    return { type: "undefined" };
  }

  if (/IntersectionObserver/.test(functionDeclaration)) {
    const threshold =
      argumentValues.find((value) => typeof value === "number") ??
      numberParam(message.params?.threshold) ??
      0;
    return domOperation(page, backendNodeId, "is_intersecting", { threshold });
  }
  if (
    /requestAnimationFrame/.test(functionDeclaration) &&
    /getBoundingClientRect/.test(functionDeclaration)
  ) {
    return domOperation(page, backendNodeId, "stable_rects");
  }
  if (/getBoundingClientRect/.test(functionDeclaration)) {
    return domOperation(page, backendNodeId, "rect");
  }
  if (/getClientRects/.test(functionDeclaration)) {
    return domOperation(page, backendNodeId, "client_rects");
  }
  if (/\.value\b/.test(functionDeclaration) && !/=/.test(functionDeclaration)) {
    return domOperation(page, backendNodeId, "get_value");
  }
  if (/Node is detached from document|Node is not of type HTMLElement/.test(functionDeclaration)) {
    return domOperation(page, backendNodeId, "assert_connected");
  }
  if (/Node\.TEXT_NODE/.test(functionDeclaration)) {
    // Return a fresh handle. Puppeteer disposes the temporary handle created
    // by adoptBackendNode, and aliasing the same objectId would release the
    // returned element handle as well.
    const objectId = `dom:${backendNodeId}:${randomUUID()}`;
    domHandles.set(objectId, backendNodeId);
    return { type: "object", subtype: "node", objectId, description: "HTMLElement" };
  }
  if (/instanceof SVGElement/.test(functionDeclaration)) {
    return domOperation(page, backendNodeId, "is_svg");
  }
  if (/scrollIntoView/.test(functionDeclaration)) {
    return domOperation(page, backendNodeId, "scroll_into_view");
  }
  if (/\.focus\s*\(/.test(functionDeclaration)) {
    return domOperation(page, backendNodeId, "focus");
  }
  if (/\.click\s*\(/.test(functionDeclaration)) {
    return domOperation(page, backendNodeId, "click");
  }
  if (/parentElement/.test(functionDeclaration)) {
    const parent = await domOperation(page, backendNodeId, "parent");
    const parentNodeId =
      typeof parent.value === "object" && parent.value !== null
        ? numberParam((parent.value as { backendNodeId?: unknown }).backendNodeId)
        : undefined;
    if (parentNodeId === undefined) return { type: "object", subtype: "null", value: null };
    const objectId = `dom:${parentNodeId}:${randomUUID()}`;
    domHandles.set(objectId, parentNodeId);
    return { type: "object", subtype: "node", objectId, description: "HTMLElement" };
  }
  if (/localName/.test(functionDeclaration)) {
    return domOperation(page, backendNodeId, "local_name");
  }
  return undefined;
}

async function handleTargetCommand(socket: WebSocket, message: CdpMessage): Promise<boolean> {
  const method = message.method ?? "";
  switch (method) {
    case "Target.createTarget": {
      const url = typeof message.params?.url === "string" ? message.params.url : "about:blank";
      const opener = pageForMessage(message);
      const targetId = randomUUID();
      const result = await requestAgent(opener, "open_page", { url, pageId: targetId });
      if (!result.ok) throw new Error(result.error?.message ?? "Unable to create target");
      const page = await waitForPage(targetId);
      send(socket, cdpResult(message, { targetId: page.pageId }));
      return true;
    }
    case "Target.getTargets":
      // Only report live pages. Do not synthesize targetCreated here: the
      // command response already refreshes Puppeteer's target cache, and
      // replaying synthetic creation events can make an old target object
      // look new.
      send(socket, cdpResult(message, { targetInfos: [...pages.values()].map(pageTarget) }));
      return true;
    case "Target.getBrowserContexts":
      send(
        socket,
        cdpResult(message, {
          browserContextIds: [...new Set([...pages.values()].map((page) => page.browserId))],
        }),
      );
      return true;
    case "Target.getTargetInfo": {
      const targetId = message.params?.targetId;
      const page = typeof targetId === "string" ? pages.get(targetId) : pageForMessage(message);
      if (!page) throw new Error(`Unknown target: ${String(targetId)}`);
      send(socket, cdpResult(message, { targetInfo: pageTarget(page) }));
      return true;
    }
    case "Target.getDevToolsTarget": {
      send(socket, cdpResult(message, {}));
      return true;
    }
    case "Target.attachToTarget": {
      const targetId = message.params?.targetId;
      if (typeof targetId !== "string") throw new Error(`Unknown target: ${String(targetId)}`);
      const page = pages.get(targetId);
      if (!page) {
        throw new Error(`Unknown target: ${String(targetId)}`);
      }
      const newSessionId = randomUUID();
      sessions.set(newSessionId, targetId);
      sessionOwners.set(newSessionId, socket);
      send(
        socket,
        cdpEvent("Target.attachedToTarget", {
          sessionId: newSessionId,
          targetInfo: { ...pageTarget(page), attached: true },
          waitingForDebugger: false,
        }),
      );
      send(socket, cdpResult(message, { sessionId: newSessionId }));
      return true;
    }
    case "Target.detachFromTarget": {
      const sessionId = message.params?.sessionId;
      const detachingSession = typeof sessionId === "string" ? sessionId : message.sessionId;
      if (detachingSession) {
        const targetId = sessions.get(detachingSession);
        const owner = sessionOwners.get(detachingSession);
        if (targetId && owner) {
          autoAttachedTargetsByClient.get(owner)?.delete(targetId);
        }
        sessions.delete(detachingSession);
        sessionOwners.delete(detachingSession);
        executionContextIds.delete(detachingSession);
      }
      send(socket, cdpResult(message, {}));
      return true;
    }
    case "Target.setDiscoverTargets":
      send(socket, cdpResult(message, {}));
      if (message.params?.discover !== false) {
        queueMicrotask(() => sendCurrentTargets(socket));
      }
      return true;
    case "Target.setAutoAttach":
      // A session-level setAutoAttach applies to children of that page
      // (iframes/workers). This bridge models one flat page per target, so
      // echoing page attachments here would recursively attach the page to
      // itself. Only the browser-level request attaches pages. Puppeteer
      // excludes page targets there because Chrome attaches to tab targets
      // first; we have no tab targets, so the page filter is ignored.
      if (!message.sessionId) {
        if (message.params?.autoAttach === false) {
          autoAttachClients.delete(socket);
        } else {
          autoAttachClients.add(socket);
        }
      }
      send(socket, cdpResult(message, {}));
      if (!message.sessionId && message.params?.autoAttach !== false) {
        queueMicrotask(() => {
          if (socket.readyState !== socket.OPEN) return true;
          // Answer the command first. Discovery and attachment events are
          // then delivered in a deterministic order for clients that were
          // connected before these pages appeared.
          for (const page of pages.values()) {
            markTargetCreated(socket, page);
            attachPage(socket, page);
          }
        });
      }
      return true;
  }
  return false;
}

async function handleRuntimeCommand(socket: WebSocket, message: CdpMessage): Promise<boolean> {
  const method = message.method ?? "";
  switch (method) {
    case "Debugger.enable":
      send(
        socket,
        cdpResult(message, { debuggerId: message.sessionId ?? `${backendBrowserId}:debugger` }),
      );
      return true;
    case "Runtime.releaseObject": {
      const objectId = message.params?.objectId;
      if (typeof objectId === "string") {
        functionHandles.delete(objectId);
        domHandles.delete(objectId);
        pollerHandles.delete(objectId);
        fakeObjectHandles.delete(objectId);
      }
      send(socket, cdpResult(message, {}));
      return true;
    }
    case "Runtime.getProperties": {
      send(socket, cdpResult(message, { result: [], internalProperties: [] }));
      return true;
    }
    case "Runtime.getIsolateId": {
      const page = pageForMessage(message);
      send(
        socket,
        cdpResult(message, { id: message.sessionId ?? `${page.browserId}:${page.pageId}` }),
      );
      return true;
    }
    case "Runtime.enable": {
      const page = pageForMessage(message);
      executionContextId(message.sessionId, "");
      // Replay every known context for this session, matching Chrome's
      // behaviour when Runtime.enable is called more than once.
      const worlds = executionContextIds.get(message.sessionId ?? "root");
      for (const worldName of worlds?.keys() ?? [""]) {
        send(socket, executionContextEvent(page, message.sessionId, worldName));
      }
      send(socket, cdpResult(message, {}));
      return true;
    }
    case "Page.createIsolatedWorld": {
      const page = pageForMessage(message);
      const worldName =
        typeof message.params?.worldName === "string" ? message.params.worldName : "isolated";
      const contextId = executionContextId(message.sessionId, worldName);
      send(socket, executionContextEvent(page, message.sessionId, worldName));
      send(socket, cdpResult(message, { executionContextId: contextId }));
      return true;
    }
    case "Page.addScriptToEvaluateOnNewDocument":
      send(socket, cdpResult(message, { identifier: randomUUID() }));
      return true;
    case "Runtime.evaluate": {
      const expression = message.params?.expression;
      if (typeof expression !== "string") throw new Error("expression is required");
      const page = pageForMessage(message);
      if (/RAFPoller|IntervalPoller|MutationPoller/.test(expression)) {
        const objectId = `puppeteer-util:${randomUUID()}`;
        fakeObjectHandles.add(objectId);
        send(
          socket,
          cdpResult(message, {
            result: {
              type: "object",
              className: "Object",
              objectId,
              description: "PuppeteerUtil",
            },
          }),
        );
        return true;
      }
      const result = await requestAgent(page, "eval_safe", { code: expression });
      if (!result.ok) throw new Error(result.error?.message ?? "Evaluation failed");
      let remoteObject = remoteObjectForResult(result);
      // Backwards compatibility with an older userscript that does not
      // report resultType/functionSource: a function serializes as
      // undefined, so use the evaluated expression as the function source.
      if (
        result.resultType === undefined &&
        result.result === undefined &&
        looksLikeFunctionExpression(expression)
      ) {
        const objectId = randomUUID();
        functionHandles.set(objectId, expression);
        remoteObject = { type: "function", objectId };
      }
      send(socket, cdpResult(message, { result: remoteObject }));
      return true;
    }
    case "Runtime.callFunctionOn": {
      const functionDeclaration = message.params?.functionDeclaration;
      if (typeof functionDeclaration !== "string") {
        throw new Error("functionDeclaration is required");
      }
      const page = pageForMessage(message);
      const objectId = message.params?.objectId;
      const argumentsList = Array.isArray(message.params?.arguments)
        ? (message.params.arguments as CdpArgument[])
        : [];
      const domBackendNodeId = domHandleForCall(message, argumentsList)?.backendNodeId;
      const domResult = await tryHandleDomCall(message, page, functionDeclaration, argumentsList);
      logDomDebug("callFunctionOn", {
        sessionId: message.sessionId,
        objectId,
        domBackendNodeId,
        handled: Boolean(domResult),
        argumentCount: argumentsList.length,
      });
      if (domResult) {
        send(socket, cdpResult(message, { result: domResult }));
        return true;
      }
      // Non-standard escape hatch for clients that used the old two-step
      // function-handle workflow. Standard callFunctionOn always executes.
      if (message.params?.createHandle === true) {
        const handleId = randomUUID();
        functionHandles.set(handleId, functionDeclaration);
        send(
          socket,
          cdpResult(message, {
            result: { type: "function", objectId: handleId, description: functionDeclaration },
          }),
        );
        return true;
      }
      const callArguments = argumentsList.map((argument) => {
        const handle = typeof argument.objectId === "string" ? argument.objectId : undefined;
        const functionSource = handle ? functionHandles.get(handle) : undefined;
        return functionSource ? `(${functionSource})` : JSON.stringify(argument.value);
      });
      const callArgumentsCode = callArguments.length ? `, ${callArguments.join(", ")}` : "";
      // Runtime.callFunctionOn always invokes functionDeclaration. This is
      // what Puppeteer uses for evaluate()/evaluateHandle() with real
      // function arguments, so it must not be treated as a request to
      // create a function handle. Function handles are created by
      // Runtime.evaluate instead.
      const storedThis = typeof objectId === "string" ? functionHandles.get(objectId) : undefined;
      const code =
        typeof objectId === "string"
          ? `(${functionDeclaration}).call(${storedThis ? `(${storedThis})` : "undefined"}${callArgumentsCode})`
          : `(${functionDeclaration})(${callArguments.join(", ")})`;
      const result = await requestAgent(page, "eval_safe", { code });
      if (!result.ok) throw new Error(result.error?.message ?? "Function execution failed");
      send(socket, cdpResult(message, { result: remoteObjectForResult(result) }));
      return true;
    }
  }
  return false;
}

async function handlePageCommand(socket: WebSocket, message: CdpMessage): Promise<boolean> {
  const method = message.method ?? "";
  switch (method) {
    case "Page.navigate": {
      const url = message.params?.url;
      if (typeof url !== "string") throw new Error("url is required");
      const page = pageForMessage(message);
      await requestAgent(page, "navigate", { url });
      page.url = url;
      send(socket, cdpResult(message, { frameId: page.pageId }));
      return true;
    }
    case "Page.reload": {
      const page = pageForMessage(message);
      const result = await requestAgent(page, "reload");
      if (!result.ok) throw new Error(result.error?.message ?? "Reload failed");
      send(socket, cdpResult(message, {}));
      return true;
    }
    case "Page.stopLoading": {
      const page = pageForMessage(message);
      const result = await requestAgent(page, "stop_loading");
      if (!result.ok) throw new Error(result.error?.message ?? "Stop loading failed");
      send(socket, cdpResult(message, {}));
      return true;
    }
    case "Page.getNavigationHistory": {
      const page = pageForMessage(message);
      const info = await requestAgent(page, "get_page_info");
      if (!info.ok) throw new Error(info.error?.message ?? "Page info failed");
      const value = info.result as { url?: string; title?: string };
      send(
        socket,
        cdpResult(message, {
          currentIndex: 0,
          entries: [
            {
              id: 0,
              url: value.url ?? page.url,
              userTypedURL: value.url ?? page.url,
              title: value.title ?? "",
            },
          ],
        }),
      );
      return true;
    }
    case "Page.navigateToHistoryEntry": {
      const page = pageForMessage(message);
      const result = await requestAgent(page, "history_back");
      if (!result.ok) throw new Error(result.error?.message ?? "History navigation failed");
      send(socket, cdpResult(message, {}));
      return true;
    }
    case "Page.clickText": {
      const text = message.params?.text;
      if (typeof text !== "string") throw new Error("text is required");
      const page = pageForMessage(message);
      const result = await requestAgent(page, "click_text", { text });
      if (!result.ok) throw new Error(result.error?.message ?? "Click failed");
      send(socket, cdpResult(message, result.result));
      return true;
    }
    case "Input.insertText": {
      const text = message.params?.text;
      if (typeof text !== "string") throw new Error("text is required");
      const page = pageForMessage(message);
      const result = await requestAgent(page, "insert_text", { text });
      if (!result.ok) throw new Error(result.error?.message ?? "Text insertion failed");
      send(socket, cdpResult(message, {}));
      return true;
    }
    case "DOM.resolveNode": {
      const backendNodeId = numberParam(message.params?.backendNodeId ?? message.params?.nodeId);
      if (backendNodeId === undefined) throw new Error("backendNodeId is required");
      const page = pageForMessage(message);
      const exists = await requestAgent(page, "get_dom_node", { backendNodeId, depth: 0 });
      if (!exists.ok) throw new Error(exists.error?.message ?? "DOM node not found");
      const objectId = `dom:${backendNodeId}:${randomUUID()}`;
      domHandles.set(objectId, backendNodeId);
      const requestedContext = numberParam(message.params?.executionContextId);
      send(
        socket,
        cdpResult(message, {
          object: {
            type: "object",
            subtype: "node",
            className: "HTMLElement",
            objectId,
            executionContextId: requestedContext ?? executionContextId(message.sessionId, ""),
            description: "HTMLElement",
          },
        }),
      );
      return true;
    }
    case "DOM.pushNodesByBackendIdsToFrontend": {
      const backendNodeIds = Array.isArray(message.params?.backendNodeIds)
        ? message.params.backendNodeIds
        : [];
      send(socket, cdpResult(message, { nodeIds: backendNodeIds.map(Number) }));
      return true;
    }
    case "DOM.describeNode": {
      const page = pageForMessage(message);
      const backendNodeId = backendNodeIdFromParams(message);
      if (backendNodeId === undefined) throw new Error("backendNodeId or objectId is required");
      const requestedDepth = numberParam(message.params?.depth) ?? 0;
      const depth = requestedDepth < 0 ? 32 : requestedDepth;
      const result = await requestAgent(page, "get_dom_node", { backendNodeId, depth });
      if (!result.ok) throw new Error(result.error?.message ?? "DOM node failed");
      send(socket, cdpResult(message, { node: result.result }));
      return true;
    }
    case "DOM.getAttributes": {
      const page = pageForMessage(message);
      const backendNodeId = backendNodeIdFromParams(message);
      if (backendNodeId === undefined) throw new Error("nodeId or objectId is required");
      const result = await requestAgent(page, "dom_operation", {
        backendNodeId,
        operation: "attributes",
      });
      if (!result.ok) throw new Error(result.error?.message ?? "DOM attributes failed");
      send(
        socket,
        cdpResult(message, {
          attributes: Array.isArray(result.result) ? result.result : [],
        }),
      );
      return true;
    }
    case "DOM.requestNode": {
      const objectId = message.params?.objectId;
      if (typeof objectId !== "string") throw new Error("objectId is required");
      const backendNodeId = domHandles.get(objectId);
      if (backendNodeId === undefined) throw new Error(`Unknown object: ${objectId}`);
      send(socket, cdpResult(message, { nodeId: backendNodeId }));
      return true;
    }
    case "DOM.focus": {
      const page = pageForMessage(message);
      const backendNodeId = backendNodeIdFromParams(message);
      if (backendNodeId === undefined) throw new Error("objectId or backendNodeId is required");
      await domOperation(page, backendNodeId, "focus");
      send(socket, cdpResult(message, {}));
      return true;
    }
    case "DOM.getContentQuads": {
      const page = pageForMessage(message);
      const backendNodeId = backendNodeIdFromParams(message);
      if (backendNodeId === undefined) throw new Error("backendNodeId or objectId is required");
      const rect = await domOperation(page, backendNodeId, "rect");
      const value = rect.value as { x: number; y: number; width: number; height: number };
      const quad = rectToQuad(value);
      logDomDebug("getContentQuads", {
        backendNodeId,
        rect: summarizeRect(value),
        center: {
          x: value.x + value.width / 2,
          y: value.y + value.height / 2,
        },
        quad,
      });
      send(socket, cdpResult(message, { quads: [quad] }));
      return true;
    }
    case "DOM.scrollIntoViewIfNeeded": {
      const page = pageForMessage(message);
      const backendNodeId = backendNodeIdFromParams(message);
      if (backendNodeId === undefined) throw new Error("objectId or backendNodeId is required");
      await domOperation(page, backendNodeId, "scroll_into_view");
      send(socket, cdpResult(message, {}));
      return true;
    }
    case "DOM.getBoxModel": {
      const page = pageForMessage(message);
      const backendNodeId = backendNodeIdFromParams(message);
      if (backendNodeId === undefined) throw new Error("backendNodeId or objectId is required");
      const rect = await domOperation(page, backendNodeId, "rect");
      const value = rect.value as { x: number; y: number; width: number; height: number };
      const quad = rectToQuad(value);
      send(
        socket,
        cdpResult(message, {
          model: {
            content: quad,
            padding: quad,
            border: quad,
            margin: quad,
            width: value.width,
            height: value.height,
          },
        }),
      );
      return true;
    }
    case "Input.dispatchMouseEvent":
    case "Input.dispatchKeyEvent": {
      const page = pageForMessage(message);
      const rawType = message.params?.type;
      const inputType =
        method === "Input.dispatchKeyEvent"
          ? rawType === "keyUp"
            ? "keyUp"
            : rawType === "char"
              ? "char"
              : "keyDown"
          : rawType;
      const result = await requestAgent(
        page,
        "dispatch_input",
        {
          ...(message.params ?? {}),
          type: inputType,
        },
        { interruptible: true },
      );
      if (!result.ok) throw new Error(result.error?.message ?? "Input dispatch failed");
      logDomDebug("input", {
        method,
        type: message.params?.type,
        x: message.params?.x,
        y: message.params?.y,
        button: message.params?.button,
        result: result.result,
      });
      send(socket, cdpResult(message, {}));
      return true;
    }
    case "DOM.getDocument": {
      const page = pageForMessage(message);
      const requestedDepth = numberParam(message.params?.depth) ?? 4;
      const depth = requestedDepth < 0 ? 32 : requestedDepth;
      const result = await requestAgent(page, "get_dom_document", { depth });
      if (!result.ok) throw new Error(result.error?.message ?? "DOM document failed");
      send(socket, cdpResult(message, { root: result.result }));
      return true;
    }
    case "DOM.querySelector": {
      const page = pageForMessage(message);
      const result = await requestAgent(page, "dom_query", {
        selector: message.params?.selector,
      });
      if (!result.ok) throw new Error(result.error?.message ?? "DOM query failed");
      send(socket, cdpResult(message, { nodeId: (result.result as { nodeId: number }).nodeId }));
      return true;
    }
    case "DOM.getOuterHTML": {
      const page = pageForMessage(message);
      const backendNodeId = backendNodeIdFromParams(message);
      const result = await requestAgent(page, "dom_outer_html", {
        ...(backendNodeId !== undefined ? { backendNodeId } : {}),
      });
      if (!result.ok) throw new Error(result.error?.message ?? "DOM HTML failed");
      send(socket, cdpResult(message, { outerHTML: result.result }));
      return true;
    }
    case "Page.getFrameTree": {
      const page = pageForMessage(message);
      send(socket, cdpResult(message, { frameTree: frameTree(page) }));
      return true;
    }
    case "Page.getResourceTree": {
      const page = pageForMessage(message);
      send(socket, cdpResult(message, { frameTree: frameTree(page), resources: [] }));
      return true;
    }
    case "Accessibility.getFullAXTree": {
      const page = pageForMessage(message);
      const depth = message.params?.depth;
      const result = await requestAgent(page, "get_accessibility_tree", {
        ...(typeof depth === "number" ? { depth } : {}),
      });
      if (!result.ok) throw new Error(result.error?.message ?? "Accessibility tree failed");
      send(socket, cdpResult(message, { nodes: result.result }));
      return true;
    }
    case "Page.getDomSummary": {
      const page = pageForMessage(message);
      const result = await requestAgent(page, "get_dom_summary");
      if (!result.ok) throw new Error(result.error?.message ?? "DOM summary failed");
      send(socket, cdpResult(message, result.result));
      return true;
    }
  }
  return false;
}

async function handle(socket: WebSocket, message: CdpMessage): Promise<void> {
  const method = message.method ?? "";
  try {
    if (await handleTargetCommand(socket, message)) return;
    if (await handleRuntimeCommand(socket, message)) return;
    if (await handlePageCommand(socket, message)) return;
    switch (method) {
      case "Browser.getVersion":
        send(
          socket,
          cdpResult(message, {
            protocolVersion: "1.3",
            product: `Remote Page Agent/${appVersion}`,
            revision: "remote-page-agent",
            userAgent: "remote-page-agent",
            jsVersion: "ECMAScript",
          }),
        );
        return;
      case "Target.activateTarget":
      case "Page.bringToFront":
      case "Page.enable":
      case "Page.setLifecycleEventsEnabled":
      case "Page.removeScriptToEvaluateOnNewDocument":
      case "DOM.enable":
      case "Network.enable":
      case "Log.enable":
      case "Performance.enable":
      case "Audits.enable":
      case "Accessibility.enable":
      case "CSS.enable":
      case "Profiler.enable":
      case "Emulation.setFocusEmulationEnabled":
      case "Emulation.setDeviceMetricsOverride":
      case "Emulation.clearDeviceMetricsOverride":
      case "Emulation.setTouchEmulationEnabled":
      case "Emulation.setEmulatedMedia":
      case "Emulation.setLocaleOverride":
      case "Emulation.setTimezoneOverride":
      case "Emulation.setGeolocationOverride":
      case "Emulation.setScriptExecutionDisabled":
      case "Emulation.setCPUThrottlingRate":
      case "Emulation.setUserAgentOverride":
      case "Runtime.addBinding":
      case "Runtime.removeBinding":
      case "Runtime.runIfWaitingForDebugger":
      case "Runtime.setAsyncCallStackDepth":
      case "Runtime.setCustomObjectFormatterEnabled":
      case "Network.setCacheDisabled":
      case "Network.setAttachDebugStack":
      case "Network.setBypassServiceWorker":
      case "Network.setBlockedURLs":
      case "Network.setExtraHTTPHeaders":
      case "Page.setBypassCSP":
      case "Page.setInterceptFileChooserDialog":
      case "WebMCP.enable":
      case "Autofill.enable":
      case "Autofill.setAddresses":
        send(socket, cdpResult(message, {}));
        return;
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
      if (remoteAgentToken && message.token !== remoteAgentToken) {
        send(socket, { type: "hello_ack", ok: false, error: { message: "Authentication failed" } });
        socket.close(1008, "Authentication failed");
        return;
      }
      const browserId = message.browserId ?? "unknown-browser";
      const requestedPageId = message.pageId ?? randomUUID();
      let pageId = requestedPageId;
      let previous = pages.get(pageId);

      // sessionStorage can be cloned into a duplicated/new tab. Never let two
      // simultaneously connected documents share a CDP targetId: that makes
      // one MCP page object route commands to the other tab.
      if (
        previous &&
        previous.socket !== socket &&
        previous.socket.readyState === previous.socket.OPEN
      ) {
        pageId = randomUUID();
        previous = undefined;
        logConnection(`Page id collision; assigned new target: page=${pageId}`);
      }

      const reconnectTimer = reconnectTimers.get(pageId);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimers.delete(pageId);
      }
      page = {
        browserId,
        pageId,
        socket,
        url: message.url ?? "about:blank",
        title: message.title ?? "Remote Page",
      };
      pages.set(pageId, page);
      resolvePageWaiters(page);
      send(socket, { type: "hello_ack", ok: true, browserId, pageId });
      logConnection(`Page connected: browser=${browserId}, page=${pageId}`);

      if (previous) {
        notifyPageUpdated(page);
        broadcastPageEvent(pageId, "Page.frameNavigated", {
          frame: {
            id: pageId,
            url: page.url,
            securityOrigin: pageOrigin(page),
            mimeType: "text/html",
          },
        });
      } else {
        notifyNewPage(page);
      }
      return;
    }
    if (message.type === "page_event" && page && typeof message.method === "string") {
      if (typeof message.url === "string") page.url = message.url;
      if (typeof message.title === "string") page.title = message.title;
      for (const client of clients) {
        send(client, cdpEvent("Target.targetInfoChanged", { targetInfo: pageTarget(page) }));
      }
      broadcastPageEvent(
        page.pageId,
        message.method,
        (message.params ?? {}) as Record<string, unknown>,
      );
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
  socket.on("close", (code, reason) => {
    logConnection(
      `Userscript WebSocket closed: code=${code} reason=${String(reason).slice(0, 120)}`,
    );
    if (page && pages.get(page.pageId)?.socket === socket) {
      for (const [id, request] of pending) {
        if (request.pageId !== page.pageId) continue;
        pending.delete(id);
        if (request.interruptible) {
          // A click/key action can tear down the document before the userscript
          // can answer. The command itself was delivered; report it as
          // completed instead of waiting for the 15s agent timeout.
          request.resolve({
            type: request.type,
            ok: true,
            result: { ok: true, pageDisconnected: true },
          });
        } else {
          request.resolve({
            type: request.type,
            ok: false,
            error: { message: "Page disconnected" },
          });
        }
      }
      const pageId = page.pageId;
      const reconnectTimer = setTimeout(() => {
        if (pages.get(pageId)?.socket !== socket) return;
        destroyPage(pageId);
      }, pageReconnectGraceMs);
      reconnectTimers.set(pageId, reconnectTimer);
      logConnection(
        `Page socket closed; waiting ${pageReconnectGraceMs}ms before destroy: browser=${page.browserId}, page=${pageId}`,
      );
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
        webSocketDebuggerUrl: publicUrl(`/devtools/browser/${backendBrowserId}`),
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
          webSocketDebuggerUrl: publicUrl(`/devtools/page/${page.pageId}`),
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
  if (path === "/agent" && !allowAgentConnection(request)) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
    socket.destroy();
    logConnection(`Rejected agent connection rate limit: address=${clientAddress(request)}`);
    return;
  }
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
      client.on("message", (data) => {
        const message = JSON.parse(String(data)) as CdpMessage;
        logCdp("recv", message);
        void handle(client, message);
      });
      client.on("close", (code, reason) => {
        clients.delete(client);
        autoAttachClients.delete(client);
        autoAttachedTargetsByClient.delete(client);
        discoveredTargetsByClient.delete(client);
        for (const [sessionId, owner] of sessionOwners) {
          if (owner !== client) continue;
          sessions.delete(sessionId);
          sessionOwners.delete(sessionId);
          executionContextIds.delete(sessionId);
        }
        logConnection(
          `CDP client disconnected (${path}) code=${code} reason=${String(reason).slice(0, 120)}`,
        );
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
