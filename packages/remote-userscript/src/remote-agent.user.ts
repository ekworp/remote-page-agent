// ==UserScript==
// @name         Remote Page Agent
// @namespace    remote-page-agent
// @version      0.1.0
// @description  Connect a page to the remote-page-agent CDP bridge.
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

const bridgeStorageKey = "remote-page-agent-bridge-url";
const defaultBridgeUrl = "ws://localhost:9222/agent";
const browserIdStorageKey = "remote-page-agent-browser-id";
const browserId = GM_getValue<string>(browserIdStorageKey, "") || crypto.randomUUID();
GM_setValue(browserIdStorageKey, browserId);
const pageId = crypto.randomUUID();

let socket: WebSocket | undefined;
let notice: HTMLDivElement | undefined;
let statusIcon: SVGSVGElement | undefined;

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
      "background: rgba(17, 24, 39, .9)",
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
    });
  }

  const colors: Record<NoticeKind, string> = {
    info: "#f59e0b",
    success: "#22c55e",
    error: "#ef4444",
  };
  notice.title = message;
  notice.setAttribute("aria-label", message);
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

function response(id: string, result: unknown): void {
  send({ id, ok: true, result });
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
    case "navigate": {
      if (typeof payload.url !== "string") {
        throw new Error("url is required");
      }
      location.href = payload.url;
      response(request.id, { url: payload.url });
      return;
    }
    case "eval_safe": {
      if (typeof payload.code !== "string") {
        throw new Error("code is required");
      }
      const value = await Function(`"use strict"; return (${payload.code})`)();
      response(request.id, value);
      return;
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

for (const method of ["log", "warn", "error"] as const) {
  const original = console[method];
  console[method] = (...args: unknown[]) => {
    original(...args);
    send({ type: "console", method, args: args.map(String), url: location.href });
  };
}

connect();
