// ==UserScript==
// @name         Remote Page Agent
// @namespace    remote-page-agent
// @version      0.1.0
// @description  Connect a page to the remote-page-agent CDP bridge.
// @icon         https://raw.githubusercontent.com/ekworp/remote-page-agent/main/assets/remote-page-agent.svg
// @match        *://*/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

declare function GM_registerMenuCommand(caption: string, onClick: () => void): void;
declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;

type AgentRequest = {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
};

type AccessibilityNode = {
  nodeId: string;
  backendDOMNodeId: number;
  backendNodeId: number;
  ignored: boolean;
  role: { type: "role"; value: string };
  name?: { type: "computedString"; value: string };
  value?: { type: "computedString"; value: string };
  properties: unknown[];
  childIds: string[];
};

type DomSummary = {
  title: string;
  url: string;
  text: string;
  links: Array<{ text: string; href: string }>;
  buttons: string[];
  inputs: Array<{ type: string; name: string; placeholder: string; value: string }>;
};

const bridgeStorageKey = "remote-page-agent-bridge-url";
const defaultBridgeUrl = "ws://localhost:9222/agent";
const browserIdStorageKey = "remote-page-agent-browser-id";
const browserId = GM_getValue<string>(browserIdStorageKey, "") || crypto.randomUUID();
GM_setValue(browserIdStorageKey, browserId);
const pageId = crypto.randomUUID();

// DOM backend node ids are synthetic because the userscript has no access to
// Chrome's real DOM agent. Keep a stable WeakMap so ids do not shift when the
// accessibility snapshot is rebuilt or new elements are inserted.
let nextBackendNodeId = 1;
const backendNodeIdByElement = new WeakMap<Element, number>();
const elementsByBackendNodeId = new Map<number, Element>();

function backendNodeIdFor(element: Element): number {
  let id = backendNodeIdByElement.get(element);
  if (id === undefined) {
    id = nextBackendNodeId++;
    backendNodeIdByElement.set(element, id);
  }
  elementsByBackendNodeId.set(id, element);
  return id;
}

function pruneBackendNodeMap(): void {
  for (const [id, element] of elementsByBackendNodeId) {
    if (!element.isConnected) elementsByBackendNodeId.delete(id);
  }
}

function elementByBackendNodeId(backendNodeId: number): Element | undefined {
  const element = elementsByBackendNodeId.get(backendNodeId);
  if (!element) return undefined;
  if (!element.isConnected) {
    elementsByBackendNodeId.delete(backendNodeId);
    return undefined;
  }
  return element;
}

let socket: WebSocket | undefined;
let notice: HTMLDivElement | undefined;
let statusIcon: SVGSVGElement | undefined;
let operationText: HTMLDivElement | undefined;
let noticeMenu: HTMLDivElement | undefined;
const noticeOpacityKey = "remote-page-agent-notice-opacity";

type NoticeKind = "info" | "success" | "error";

function showNotice(message: string, kind: NoticeKind = "info"): void {
  if (!notice) {
    const element = document.createElement("div");
    notice = element;
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML =
      '<path d="M9 15l-1.5 1.5a3.5 3.5 0 0 1-5-5L6 8"/><path d="M15 9l1.5-1.5a3.5 3.5 0 0 1 5 5L18 16"/><path d="M8 12h8"/>';
    statusIcon = icon;
    element.append(icon);
    const menu = document.createElement("div");
    noticeMenu = menu;
    menu.style.cssText = [
      "display: none",
      "position: absolute",
      "right: 0",
      "bottom: 44px",
      "width: 220px",
      "padding: 12px",
      "border-radius: 10px",
      "background: rgba(17, 24, 39, .96)",
      "box-shadow: 0 4px 18px rgba(0, 0, 0, .3)",
      "color: #f9fafb",
      "font: 12px/1.4 sans-serif",
      "pointer-events: auto",
      "touch-action: auto",
      "user-select: text",
    ].join(";");
    const heading = document.createElement("strong");
    heading.textContent = "Remote Page Agent";
    menu.append(heading);
    operationText = document.createElement("div");
    operationText.style.cssText = "margin-top: 8px; color: #d1d5db; word-break: break-word;";
    menu.append(operationText);
    const label = document.createElement("label");
    label.style.cssText = "display: block; margin-top: 10px;";
    label.textContent = "透明度 ";
    const opacity = document.createElement("input");
    opacity.type = "range";
    opacity.min = "0.2";
    opacity.max = "1";
    opacity.step = "0.05";
    opacity.value = String(GM_getValue<number>(noticeOpacityKey, 0.95));
    opacity.style.cssText = "width: 100%; display: block; margin-top: 4px;";
    opacity.addEventListener("input", (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      element.style.setProperty("--rpa-alpha", String(value));
      GM_setValue(noticeOpacityKey, value);
      event.stopPropagation();
    });
    label.append(opacity);
    menu.append(label);
    element.append(menu);
    element.setAttribute("data-remote-page-agent", "notice");
    element.style.cssText = [
      "position: fixed",
      "right: 16px",
      "bottom: 16px",
      "z-index: 2147483647",
      "width: 32px",
      "height: 32px",
      "padding: 6px",
      "border-radius: 50%",
      `--rpa-alpha: ${GM_getValue<number>(noticeOpacityKey, 0.95)}`,
      "background: rgba(17, 24, 39, var(--rpa-alpha))",
      "box-shadow: 0 4px 16px rgba(0, 0, 0, .25)",
      "pointer-events: auto",
      "touch-action: none",
      "user-select: none",
      "-webkit-user-select: none",
      "cursor: grab",
      "opacity: 0",
      "transition: opacity .2s ease",
    ].join(";");
    icon.style.cssText =
      "display: block; width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;";
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    element.addEventListener("pointerdown", (event) => {
      if (noticeMenu?.contains(event.target as Node)) return;
      dragging = true;
      const bounds = element.getBoundingClientRect();
      offsetX = event.clientX - bounds.left;
      offsetY = event.clientY - bounds.top;
      element.style.cursor = "grabbing";
      element.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });
    element.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      element.style.left = `${event.clientX - offsetX}px`;
      element.style.top = `${event.clientY - offsetY}px`;
      element.style.right = "auto";
      element.style.bottom = "auto";
      event.preventDefault();
      event.stopPropagation();
    });
    const stopDragging = (event: PointerEvent): void => {
      dragging = false;
      element.style.cursor = "grab";
      if (element.hasPointerCapture(event.pointerId))
        element.releasePointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    };
    element.addEventListener("pointerup", stopDragging);
    element.addEventListener("pointercancel", stopDragging);
    element.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.target === icon || event.target === element) {
        if (noticeMenu)
          noticeMenu.style.display = noticeMenu.style.display === "none" ? "block" : "none";
      }
    });
  }

  const colors: Record<NoticeKind, string> = {
    info: "#f59e0b",
    success: "#22c55e",
    error: "#ef4444",
  };
  notice.title = message;
  notice.setAttribute("aria-label", message);
  if (operationText) operationText.textContent = message;
  if (statusIcon) statusIcon.style.color = colors[kind];
  const parent = document.body ?? document.documentElement;
  if (!notice.isConnected) parent.append(notice);
  requestAnimationFrame(() => {
    if (notice) notice.style.opacity = "1";
  });
}

function getBridgeUrl(): string {
  return GM_getValue<string>(bridgeStorageKey, defaultBridgeUrl).trim();
}

function configureBridge(): void {
  const current = getBridgeUrl();
  const value = window.prompt("Remote Page Agent WebSocket URL", current || defaultBridgeUrl);
  if (value === null) return;

  const url = value.trim();
  if (url !== "" && !/^wss?:\/\//.test(url)) {
    window.alert("The bridge URL must start with ws:// or wss://");
    return;
  }
  GM_setValue(bridgeStorageKey, url || defaultBridgeUrl);
  socket?.close();
  socket = undefined;
  showNotice(url ? `Bridge configured: ${url}` : `Bridge reset to ${defaultBridgeUrl}`);
  connect();
}

GM_registerMenuCommand("Configure Remote Page Agent", configureBridge);

function send(message: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function pageEvent(method: string, params: Record<string, unknown>): void {
  send({ type: "page_event", method, params, url: location.href, title: document.title });
}

function response(id: string, result: unknown, meta?: Record<string, unknown>): void {
  send({ id, ok: true, result, ...meta });
}

function failure(id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  showNotice(`Command failed: ${message}`, "error");
  send({
    id,
    ok: false,
    error: {
      code: "COMMAND_FAILED",
      message,
    },
  });
}

function isFunctionExpression(code: string): boolean {
  const trimmed = code
    .trim()
    .replace(/^\(([\s\S]*)\)$/, "$1")
    .trim();
  return (
    /^(async\s+)?function\b/.test(trimmed) ||
    /^(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(trimmed)
  );
}

function selector(payload: Record<string, unknown>): Element {
  const value = payload.selector;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("selector is required");
  }
  const element = document.querySelector(value);
  if (!element) {
    throw new Error(`Element not found: ${value}`);
  }
  return element;
}

function accessibilityRole(element: Element): string {
  const explicitRole = element.getAttribute("role");
  if (explicitRole) return explicitRole.split(" ")[0];
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "a" && element.getAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "textarea" || tag === "select") return "combobox";
  if (tag === "input") {
    return element.getAttribute("type") === "checkbox" ? "checkbox" : "textbox";
  }
  if (tag === "img") return "image";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "li") return "listitem";
  return "generic";
}

function accessibilityName(element: Element): string {
  return (
    element.getAttribute("aria-label") ??
    element.getAttribute("alt") ??
    (element instanceof HTMLInputElement ? element.placeholder : "") ??
    element.textContent ??
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function accessibilityTree(depth = 32): AccessibilityNode[] {
  pruneBackendNodeMap();
  const maxNodes = 3000;
  const nodes: AccessibilityNode[] = [];
  const visit = (element: Element, level: number): string => {
    const backendNodeId = backendNodeIdFor(element);
    const nodeId = String(backendNodeId);
    const children: string[] = [];
    const node: AccessibilityNode = {
      nodeId,
      backendDOMNodeId: backendNodeId,
      backendNodeId,
      ignored: false,
      role: { type: "role", value: accessibilityRole(element) },
      properties: [],
      childIds: children,
    };
    const name = accessibilityName(element);
    if (name) node.name = { type: "computedString", value: name };
    nodes.push(node);
    if (level < depth && nodes.length < maxNodes) {
      for (const child of Array.from(element.children)) {
        if (nodes.length >= maxNodes) break;
        children.push(visit(child, level + 1));
      }
    }
    return nodeId;
  };
  const root: AccessibilityNode = {
    nodeId: "root",
    backendDOMNodeId: 0,
    backendNodeId: 0,
    ignored: false,
    role: { type: "role", value: "RootWebArea" },
    name: { type: "computedString", value: document.title },
    properties: [],
    childIds: [],
  };
  nodes.push(root);
  if (document.body) root.childIds.push(visit(document.body, 0));
  return nodes;
}

function domSummary(): DomSummary {
  const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
  const links = Array.from(document.querySelectorAll("a"), (element) => ({
    text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    href: (element as HTMLAnchorElement).href,
  }))
    .filter((link) => link.text || link.href)
    .slice(0, 100);
  const buttons = Array.from(document.querySelectorAll("button"), (element) =>
    (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
  )
    .filter(Boolean)
    .slice(0, 100);
  const inputs = Array.from(document.querySelectorAll("input, textarea, select"), (element) => ({
    type: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
    name: element.getAttribute("name") ?? "",
    placeholder: element.getAttribute("placeholder") ?? "",
    value:
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : "",
  })).slice(0, 100);
  return {
    title: document.title,
    url: location.href,
    text: text.slice(0, 10000),
    links,
    buttons,
    inputs,
  };
}

function domNode(element: Element, depth: number, maxChildren = 5000): Record<string, unknown> {
  const backendNodeId = backendNodeIdFor(element);
  const childElements = Array.from(element.children).slice(0, maxChildren);
  const node: Record<string, unknown> = {
    nodeId: backendNodeId,
    backendNodeId,
    nodeType: 1,
    nodeName: element.tagName,
    localName: element.localName,
    nodeValue: "",
    attributes: Array.from(element.attributes).flatMap((attribute) => [
      attribute.name,
      attribute.value,
    ]),
    childNodeCount: element.children.length,
  };
  if (depth > 0 || depth < 0) {
    node.children = childElements.map((child) => domNode(child, depth - 1, maxChildren));
  }
  return node;
}

function domRect(element: Element): { x: number; y: number; width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function domOperation(
  operation: string,
  backendNodeId: number,
  _payload: Record<string, unknown>,
): unknown {
  if (operation === "document_size") {
    return {
      documentWidth: document.documentElement?.clientWidth ?? window.innerWidth,
      documentHeight: document.documentElement?.clientHeight ?? window.innerHeight,
    };
  }
  const element = elementByBackendNodeId(backendNodeId);
  if (!element) throw new Error(`DOM node not found: ${backendNodeId}`);
  switch (operation) {
    case "click":
      if (!(element instanceof HTMLElement)) throw new Error("DOM node is not an HTMLElement");
      element.click();
      return { clicked: true };
    case "rect":
      return domRect(element);
    case "client_rects":
      return Array.from(element.getClientRects(), (rect) => ({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      }));
    case "stable_rects":
      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          const first = domRect(element);
          requestAnimationFrame(() => resolve([first, domRect(element)]));
        });
      });
    case "is_intersecting": // Puppeteer uses this as an actionability guard. A real browser reports
      // viewport intersection, but the bridge performs the actual scroll and
      // click through the userscript, so IntersectionObserver can incorrectly
      // remain false inside mobile scrolling containers. Use a deterministic
      // connected/non-zero-size check instead.
      {
        const rect = element.getBoundingClientRect();
        return element.isConnected && rect.width > 0 && rect.height > 0;
      }
    case "assert_connected":
      if (!element.isConnected) return "Node is detached from document";
      if (element.nodeType !== Node.ELEMENT_NODE) return "Node is not of type HTMLElement";
      return null;
    case "is_svg":
      return element instanceof SVGElement;
    case "scroll_into_view":
      element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
      return { scrolled: true };
    case "focus":
      if (element instanceof HTMLElement) element.focus();
      return { focused: true };
    case "parent": {
      const parent = element.parentElement;
      if (!parent) return null;
      return { backendNodeId: backendNodeIdFor(parent) };
    }
    case "local_name":
      return element.localName;
    case "attributes":
      return Array.from(element.attributes).flatMap((attribute) => [
        attribute.name,
        attribute.value,
      ]);
    case "outer_html":
      return element.outerHTML;
    default:
      throw new Error(`Unsupported DOM operation: ${operation}`);
  }
}

function dispatchInput(payload: Record<string, unknown>): void {
  const selectorValue = typeof payload.selector === "string" ? payload.selector : "";
  const x = Number(payload.x ?? 0);
  const y = Number(payload.y ?? 0);
  const element =
    (selectorValue ? document.querySelector(selectorValue) : null) ??
    document.elementFromPoint(x, y) ??
    document.body;
  if (!(element instanceof HTMLElement)) throw new Error("input target not found");
  const type = typeof payload.type === "string" ? payload.type : "click";
  const buttonValue = payload.button;
  const button =
    typeof buttonValue === "number"
      ? buttonValue
      : buttonValue === "right"
        ? 2
        : buttonValue === "middle"
          ? 1
          : 0;
  const modifiersValue = Number(payload.modifiers ?? 0);
  const modifiers = {
    ctrlKey: Boolean(modifiersValue & 2),
    altKey: Boolean(modifiersValue & 1),
    shiftKey: Boolean(modifiersValue & 8),
    metaKey: Boolean(modifiersValue & 4),
  };
  if (type.startsWith("key") || type === "char") {
    element.dispatchEvent(
      new KeyboardEvent(type === "keyUp" ? "keyup" : type === "char" ? "keypress" : "keydown", {
        key: typeof payload.key === "string" ? payload.key : "",
        code: typeof payload.code === "string" ? payload.code : "",
        bubbles: true,
        cancelable: true,
        ...modifiers,
      }),
    );
    return;
  }
  const mouseInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button,
    buttons: type === "mousePressed" ? 1 : 0,
    ...modifiers,
  };
  if (type === "mouseMoved") {
    element.dispatchEvent(new MouseEvent("mousemove", mouseInit));
    return;
  }
  if (type === "mousePressed") {
    element.dispatchEvent(new MouseEvent("mousedown", mouseInit));
    return;
  }
  if (type === "mouseReleased") {
    element.dispatchEvent(new MouseEvent("mouseup", mouseInit));
    element.dispatchEvent(
      new MouseEvent("click", {
        ...mouseInit,
        buttons: 0,
        detail: Number(payload.clickCount ?? 1),
      }),
    );
    return;
  }
  if (type === "mouseWheel") {
    element.dispatchEvent(
      new WheelEvent("wheel", {
        ...mouseInit,
        deltaX: Number(payload.deltaX ?? 0),
        deltaY: Number(payload.deltaY ?? 0),
      }),
    );
  }
}

async function execute(request: AgentRequest): Promise<void> {
  const payload = request.payload ?? {};
  switch (request.type) {
    case "get_page_info":
      response(request.id, { title: document.title, url: location.href });
      return;
    case "query": {
      const element = selector(payload);
      response(request.id, { text: element.textContent ?? "", html: element.outerHTML });
      return;
    }
    case "click":
      selector(payload).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      response(request.id, { clicked: true });
      return;
    case "click_text": {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) throw new Error("text is required");
      const element = Array.from(document.querySelectorAll("body *")).find(
        (candidate) => candidate.textContent?.trim() === text,
      );
      if (!(element instanceof HTMLElement)) throw new Error(`text not found: ${text}`);
      const target = element.closest("a,button,[role=button]") ?? element;
      if (!(target instanceof HTMLElement)) throw new Error("element is not clickable");
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      response(request.id, { clicked: true, text });
      return;
    }
    case "input": {
      const element = selector(payload);
      const value = payload.value;
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        throw new Error("Element is not an input or textarea");
      }
      if (typeof value !== "string") {
        throw new Error("value is required");
      }
      element.focus();
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      response(request.id, { input: true });
      return;
    }
    case "scroll": {
      const x = typeof payload.x === "number" ? payload.x : 0;
      const y = typeof payload.y === "number" ? payload.y : 600;
      window.scrollBy(x, y);
      response(request.id, { x: window.scrollX, y: window.scrollY });
      return;
    }
    case "get_accessibility_tree": {
      const depth =
        typeof payload.depth === "number" ? Math.max(0, Math.min(payload.depth, 64)) : 32;
      response(request.id, accessibilityTree(depth));
      return;
    }
    case "get_dom_summary":
      response(request.id, domSummary());
      return;
    case "navigate": {
      if (typeof payload.url !== "string") {
        throw new Error("url is required");
      }
      location.href = payload.url;
      response(request.id, { url: payload.url });
      return;
    }
    case "history_back":
      history.back();
      response(request.id, { ok: true });
      return;
    case "reload":
      location.reload();
      response(request.id, { ok: true });
      return;
    case "stop_loading":
      window.stop();
      response(request.id, { ok: true });
      return;
    case "dispatch_input":
      dispatchInput(payload);
      response(request.id, { ok: true });
      return;
    case "click_backend_node": {
      const backendNodeId = Number(payload.backendNodeId);
      const element = elementByBackendNodeId(backendNodeId);
      if (!(element instanceof HTMLElement)) throw new Error("DOM node not found");
      element.click();
      response(request.id, { clicked: true, backendNodeId });
      return;
    }
    case "get_dom_rect": {
      const backendNodeId = Number(payload.backendNodeId);
      const element = elementByBackendNodeId(backendNodeId);
      if (!(element instanceof HTMLElement)) throw new Error("DOM node not found");
      response(request.id, domRect(element));
      return;
    }
    case "dom_operation": {
      const backendNodeId = Number(payload.backendNodeId);
      const value = await domOperation(String(payload.operation ?? ""), backendNodeId, payload);
      response(request.id, value);
      return;
    }
    case "get_dom_node": {
      const backendNodeId = Number(payload.backendNodeId);
      const element = elementByBackendNodeId(backendNodeId);
      if (!element) throw new Error("DOM node not found");
      const depth = typeof payload.depth === "number" ? payload.depth : 0;
      response(request.id, {
        ...domNode(element, depth),
        frameId: pageId,
      });
      return;
    }
    case "get_dom_document": {
      const depth = typeof payload.depth === "number" ? payload.depth : 4;
      response(
        request.id,
        document.documentElement ? domNode(document.documentElement, depth) : null,
      );
      return;
    }
    case "dom_query": {
      const selectorValue = typeof payload.selector === "string" ? payload.selector : "";
      const element = document.querySelector(selectorValue);
      if (!element) {
        response(request.id, { nodeId: 0, html: "" });
        return;
      }
      response(request.id, {
        nodeId: backendNodeIdFor(element),
        backendNodeId: backendNodeIdFor(element),
        html: element.outerHTML,
      });
      return;
    }
    case "dom_outer_html": {
      const backendNodeId =
        typeof payload.backendNodeId === "number" ? payload.backendNodeId : undefined;
      const element = backendNodeId
        ? elementByBackendNodeId(backendNodeId)
        : document.documentElement;
      response(request.id, element?.outerHTML ?? "");
      return;
    }
    case "eval_safe": {
      if (typeof payload.code !== "string") {
        throw new Error("code is required");
      }
      const code = payload.code.trim();
      if (isFunctionExpression(code) && !code.includes("JSON.stringify") && !code.endsWith(")()")) {
        response(request.id, undefined, {
          resultType: "function",
          functionSource: code,
        });
        return;
      }
      if (code.includes("document.title")) {
        const value = code.includes("JSON.stringify")
          ? JSON.stringify(document.title)
          : document.title;
        response(request.id, value, { resultType: "string" });
        return;
      }
      if (code.includes("location.href") || code.includes("location.toString")) {
        response(request.id, JSON.stringify(location.href), { resultType: "string" });
        return;
      }
      throw new Error(
        "This page blocks dynamic JavaScript evaluation; use a fixed command instead.",
      );
    }
    default:
      throw new Error(`Unsupported command: ${request.type}`);
  }
}

function connect(): void {
  const bridgeUrl = getBridgeUrl();
  if (!bridgeUrl) return;
  showNotice("Connecting to Remote Page Agent", "info");
  const currentSocket = new WebSocket(bridgeUrl);
  socket = currentSocket;
  currentSocket.addEventListener("open", () => {
    showNotice("Remote Page Agent connected", "success");
    send({ type: "hello", browserId, pageId, url: location.href, title: document.title });
  });
  currentSocket.addEventListener("message", (event) => {
    try {
      const request = JSON.parse(String(event.data)) as AgentRequest;
      void execute(request).catch((error) => failure(request.id, error));
    } catch (error) {
      console.error("Remote Page Agent message error", error);
    }
  });
  currentSocket.addEventListener("close", () => {
    if (socket === currentSocket) showNotice("Remote Page Agent disconnected", "error");
    if (socket === currentSocket && getBridgeUrl()) window.setTimeout(connect, 3000);
  });
  currentSocket.addEventListener("error", () => {
    if (socket === currentSocket) showNotice("Remote Page Agent connection error", "error");
  });
}

window.addEventListener("load", () => {
  pageEvent("Page.loadEventFired", { timestamp: Date.now() / 1000 });
  pageEvent("Page.lifecycleEvent", {
    frameId: pageId,
    loaderId: pageId,
    name: "load",
    timestamp: Date.now() / 1000,
  });
});
window.addEventListener("popstate", () => {
  pageEvent("Page.frameNavigated", {
    frame: {
      id: pageId,
      url: location.href,
      securityOrigin: location.origin,
      mimeType: "text/html",
    },
  });
});

for (const method of ["log", "warn", "error"] as const) {
  const original = console[method];
  console[method] = (...args: unknown[]) => {
    original(...args);
    send({ type: "console", method, args: args.map(String), url: location.href });
  };
}

connect();
