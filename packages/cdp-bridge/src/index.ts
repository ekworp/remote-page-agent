import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.PORT ?? 9222);
const host = process.env.HOST ?? "127.0.0.1";
const publicHost = process.env.PUBLIC_HOST ?? host;
const publicProtocol = process.env.PUBLIC_PROTOCOL ?? "ws";
const publicOrigin = (
  process.env.PUBLIC_ORIGIN ?? `${publicProtocol}://${publicHost}:${port}`
).replace(/\/$/, "");
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
  resolve: (message: AgentMessage) => void;
};

const pages = new Map<string, PageConnection>();
const clients = new Set<WebSocket>();
const pending = new Map<string, PendingRequest>();
const sessions = new Map<string, string>();
const functionHandles = new Map<string, string>();
const domHandles = new Map<string, number>();
const pollerHandles = new Set<string>();
const fakeObjectHandles = new Set<string>();
const executionContextIds = new Map<string, Map<string, number>>();
let nextExecutionContextId = 1;
const cdpDebug = process.env.CDP_DEBUG === "1" || process.env.CDP_DEBUG === "true";

function publicUrl(path: string): string {
  return `${publicOrigin}${path}`;
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

function summarizeFunctionDeclaration(source: string): string {
  const firstLine = source.split("\n", 1)[0]?.trim() ?? "";
  return `${firstLine.slice(0, 120)}${source.length > firstLine.length || firstLine.length > 120 ? "…" : ""}`;
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
  for (const argument of argumentsList) {
    if (typeof argument.objectId === "string" && domHandles.has(argument.objectId)) {
      return {
        objectId: argument.objectId,
        backendNodeId: domHandles.get(argument.objectId) as number,
      };
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

async function domOperation(
  page: PageConnection,
  backendNodeId: number,
  operation: string,
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await requestAgent(page, "dom_operation", {
    backendNodeId,
    operation,
    ...payload,
  });
  if (!result.ok) throw new Error(result.error?.message ?? `DOM operation failed: ${operation}`);
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

  if (/RAFPoller|IntervalPoller|MutationPoller/.test(functionDeclaration)) {
    const objectId = `poller:${randomUUID()}`;
    pollerHandles.add(objectId);
    return { type: "object", className: "Object", objectId, description: "Poller" };
  }

  if (pollerObjectIdForCall(message, argumentsList)) {
    if (/\.result\s*\(/.test(functionDeclaration)) return { type: "boolean", value: true };
    return { type: "undefined" };
  }

  if (/function addPageBinding/.test(functionDeclaration)) {
    // Puppeteer's binding shim is not needed by the fixed DOM commands.
    return { type: "undefined" };
  }

  if (/documentWidth|documentHeight/.test(functionDeclaration)) {
    return domOperation(page, 0, "document_size");
  }

  const domHandle = domHandleForCall(message, argumentsList);
  if (!domHandle) return undefined;
  const backendNodeId = domHandle.backendNodeId;

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
      case "Target.getBrowserContexts":
        send(
          socket,
          cdpResult(message, {
            browserContextIds: [...new Set([...pages.values()].map((page) => page.browserId))],
          }),
        );
        return;
      case "Target.getTargetInfo": {
        const targetId = message.params?.targetId;
        const page = typeof targetId === "string" ? pages.get(targetId) : pageForMessage(message);
        if (!page) throw new Error(`Unknown target: ${String(targetId)}`);
        send(socket, cdpResult(message, { targetInfo: pageTarget(page) }));
        return;
      }
      case "Target.getDevToolsTarget": {
        send(socket, cdpResult(message, {}));
        return;
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
        send(
          socket,
          cdpEvent("Target.attachedToTarget", {
            sessionId: newSessionId,
            targetInfo: { ...pageTarget(page), attached: true },
            waitingForDebugger: false,
          }),
        );
        send(socket, cdpResult(message, { sessionId: newSessionId }));
        return;
      }
      case "Target.detachFromTarget": {
        const sessionId = message.params?.sessionId;
        const detachingSession = typeof sessionId === "string" ? sessionId : message.sessionId;
        if (detachingSession) {
          sessions.delete(detachingSession);
          executionContextIds.delete(detachingSession);
        }
        send(socket, cdpResult(message, {}));
        return;
      }
      case "Target.setDiscoverTargets":
        if (message.params?.discover !== false) {
          for (const page of pages.values()) {
            send(socket, cdpEvent("Target.targetCreated", { targetInfo: pageTarget(page) }));
          }
        }
        send(socket, cdpResult(message, {}));
        return;
      case "Target.setAutoAttach":
        // A session-level setAutoAttach applies to children of that page
        // (iframes/workers). This bridge models one flat page per target, so
        // echoing page attachments here would recursively attach the page to
        // itself. Only the browser-level request attaches pages. Puppeteer
        // excludes page targets there because Chrome attaches to tab targets
        // first; we have no tab targets, so the page filter is ignored.
        if (!message.sessionId && message.params?.autoAttach !== false) {
          for (const page of pages.values()) {
            const autoAttachSessionId = randomUUID();
            sessions.set(autoAttachSessionId, page.pageId);
            send(
              socket,
              cdpEvent("Target.attachedToTarget", {
                sessionId: autoAttachSessionId,
                targetInfo: { ...pageTarget(page), attached: true },
                waitingForDebugger: false,
              }),
            );
          }
        }
        send(socket, cdpResult(message, {}));
        return;
      case "Target.activateTarget":
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
      case "Debugger.enable":
        send(
          socket,
          cdpResult(message, { debuggerId: message.sessionId ?? `${backendBrowserId}:debugger` }),
        );
        return;
      case "Runtime.releaseObject": {
        const objectId = message.params?.objectId;
        if (typeof objectId === "string") {
          functionHandles.delete(objectId);
          domHandles.delete(objectId);
          pollerHandles.delete(objectId);
          fakeObjectHandles.delete(objectId);
        }
        send(socket, cdpResult(message, {}));
        return;
      }
      case "Runtime.getProperties": {
        send(socket, cdpResult(message, { result: [], internalProperties: [] }));
        return;
      }
      case "Runtime.getIsolateId": {
        const page = pageForMessage(message);
        send(
          socket,
          cdpResult(message, { id: message.sessionId ?? `${page.browserId}:${page.pageId}` }),
        );
        return;
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
        return;
      }
      case "Page.createIsolatedWorld": {
        const page = pageForMessage(message);
        const worldName =
          typeof message.params?.worldName === "string" ? message.params.worldName : "isolated";
        const contextId = executionContextId(message.sessionId, worldName);
        send(socket, executionContextEvent(page, message.sessionId, worldName));
        send(socket, cdpResult(message, { executionContextId: contextId }));
        return;
      }
      case "Page.addScriptToEvaluateOnNewDocument":
        send(socket, cdpResult(message, { identifier: randomUUID() }));
        return;
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
          return;
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
        return;
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
        const domResult = await tryHandleDomCall(message, page, functionDeclaration, argumentsList);
        if (domResult) {
          send(socket, cdpResult(message, { result: domResult }));
          return;
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
          return;
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
      case "Page.reload": {
        const page = pageForMessage(message);
        const result = await requestAgent(page, "reload");
        if (!result.ok) throw new Error(result.error?.message ?? "Reload failed");
        send(socket, cdpResult(message, {}));
        return;
      }
      case "Page.stopLoading": {
        const page = pageForMessage(message);
        const result = await requestAgent(page, "stop_loading");
        if (!result.ok) throw new Error(result.error?.message ?? "Stop loading failed");
        send(socket, cdpResult(message, {}));
        return;
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
        return;
      }
      case "Page.navigateToHistoryEntry": {
        const page = pageForMessage(message);
        const result = await requestAgent(page, "history_back");
        if (!result.ok) throw new Error(result.error?.message ?? "History navigation failed");
        send(socket, cdpResult(message, {}));
        return;
      }
      case "Page.clickText": {
        const text = message.params?.text;
        if (typeof text !== "string") throw new Error("text is required");
        const page = pageForMessage(message);
        const result = await requestAgent(page, "click_text", { text });
        if (!result.ok) throw new Error(result.error?.message ?? "Click failed");
        send(socket, cdpResult(message, result.result));
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
        return;
      }
      case "DOM.pushNodesByBackendIdsToFrontend": {
        const backendNodeIds = Array.isArray(message.params?.backendNodeIds)
          ? message.params.backendNodeIds
          : [];
        send(socket, cdpResult(message, { nodeIds: backendNodeIds.map(Number) }));
        return;
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
        return;
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
        return;
      }
      case "DOM.requestNode": {
        const objectId = message.params?.objectId;
        if (typeof objectId !== "string") throw new Error("objectId is required");
        const backendNodeId = domHandles.get(objectId);
        if (backendNodeId === undefined) throw new Error(`Unknown object: ${objectId}`);
        send(socket, cdpResult(message, { nodeId: backendNodeId }));
        return;
      }
      case "DOM.focus": {
        const page = pageForMessage(message);
        const backendNodeId = backendNodeIdFromParams(message);
        if (backendNodeId === undefined) throw new Error("objectId or backendNodeId is required");
        await domOperation(page, backendNodeId, "focus");
        send(socket, cdpResult(message, {}));
        return;
      }
      case "DOM.getContentQuads": {
        const page = pageForMessage(message);
        const backendNodeId = backendNodeIdFromParams(message);
        if (backendNodeId === undefined) throw new Error("backendNodeId or objectId is required");
        const rect = await domOperation(page, backendNodeId, "rect");
        const value = rect.value as { x: number; y: number; width: number; height: number };
        send(
          socket,
          cdpResult(message, {
            quads: [
              [
                value.x,
                value.y,
                value.x + value.width,
                value.y,
                value.x + value.width,
                value.y + value.height,
                value.x,
                value.y + value.height,
              ],
            ],
          }),
        );
        return;
      }
      case "DOM.scrollIntoViewIfNeeded": {
        const page = pageForMessage(message);
        const backendNodeId = backendNodeIdFromParams(message);
        if (backendNodeId === undefined) throw new Error("objectId or backendNodeId is required");
        await domOperation(page, backendNodeId, "scroll_into_view");
        send(socket, cdpResult(message, {}));
        return;
      }
      case "DOM.getBoxModel": {
        const page = pageForMessage(message);
        const backendNodeId = backendNodeIdFromParams(message);
        if (backendNodeId === undefined) throw new Error("backendNodeId or objectId is required");
        const rect = await domOperation(page, backendNodeId, "rect");
        const value = rect.value as { x: number; y: number; width: number; height: number };
        const quad = [
          value.x,
          value.y,
          value.x + value.width,
          value.y,
          value.x + value.width,
          value.y + value.height,
          value.x,
          value.y + value.height,
        ];
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
        return;
      }
      case "Input.dispatchMouseEvent":
      case "Input.dispatchKeyEvent": {
        const page = pageForMessage(message);
        const result = await requestAgent(page, "dispatch_input", {
          ...(message.params ?? {}),
          type:
            method === "Input.dispatchKeyEvent"
              ? message.params?.type === "keyUp"
                ? "keyUp"
                : "keyDown"
              : message.params?.type,
        });
        if (!result.ok) throw new Error(result.error?.message ?? "Input dispatch failed");
        send(socket, cdpResult(message, {}));
        return;
      }
      case "DOM.getDocument": {
        const page = pageForMessage(message);
        const requestedDepth = numberParam(message.params?.depth) ?? 4;
        const depth = requestedDepth < 0 ? 32 : requestedDepth;
        const result = await requestAgent(page, "get_dom_document", { depth });
        if (!result.ok) throw new Error(result.error?.message ?? "DOM document failed");
        send(socket, cdpResult(message, { root: result.result }));
        return;
      }
      case "DOM.querySelector": {
        const page = pageForMessage(message);
        const result = await requestAgent(page, "dom_query", {
          selector: message.params?.selector,
        });
        if (!result.ok) throw new Error(result.error?.message ?? "DOM query failed");
        send(socket, cdpResult(message, { nodeId: (result.result as { nodeId: number }).nodeId }));
        return;
      }
      case "DOM.getOuterHTML": {
        const page = pageForMessage(message);
        const backendNodeId = backendNodeIdFromParams(message);
        const result = await requestAgent(page, "dom_outer_html", {
          ...(backendNodeId !== undefined ? { backendNodeId } : {}),
        });
        if (!result.ok) throw new Error(result.error?.message ?? "DOM HTML failed");
        send(socket, cdpResult(message, { outerHTML: result.result }));
        return;
      }
      case "Page.getFrameTree": {
        const page = pageForMessage(message);
        send(socket, cdpResult(message, { frameTree: frameTree(page) }));
        return;
      }
      case "Page.getResourceTree": {
        const page = pageForMessage(message);
        send(socket, cdpResult(message, { frameTree: frameTree(page), resources: [] }));
        return;
      }
      case "Accessibility.getFullAXTree": {
        const page = pageForMessage(message);
        const depth = message.params?.depth;
        const result = await requestAgent(page, "get_accessibility_tree", {
          ...(typeof depth === "number" ? { depth } : {}),
        });
        if (!result.ok) throw new Error(result.error?.message ?? "Accessibility tree failed");
        send(socket, cdpResult(message, { nodes: result.result }));
        return;
      }
      case "Page.getDomSummary": {
        const page = pageForMessage(message);
        const result = await requestAgent(page, "get_dom_summary");
        if (!result.ok) throw new Error(result.error?.message ?? "DOM summary failed");
        send(socket, cdpResult(message, result.result));
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
      broadcast({ method: "Target.targetCreated", params: { targetInfo: pageTarget(page) } });
      return;
    }
    if (message.type === "page_event" && page && typeof message.method === "string") {
      if (typeof message.url === "string") page.url = message.url;
      if (typeof message.title === "string") page.title = message.title;
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
  socket.on("close", () => {
    if (page && pages.get(page.pageId)?.socket === socket) {
      broadcast({ method: "Target.targetDestroyed", params: { targetId: page.pageId } });
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
