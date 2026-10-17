// ==UserScript==
// @name         Remote Page Agent
// @namespace    remote-page-agent
// @version      0.1.0
// @description  Connect a page to the remote-page-agent CDP bridge.
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

type AgentRequest = {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
};

const bridgeUrl = "ws://YOUR_SERVER_HOST:8787/agent";
const deviceId = localStorage.getItem("remote-page-agent-device") ?? crypto.randomUUID();
localStorage.setItem("remote-page-agent-device", deviceId);

let socket: WebSocket | undefined;

function send(message: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function response(id: string, result: unknown): void {
  send({ id, ok: true, result });
}

function failure(id: string, error: unknown): void {
  send({
    id,
    ok: false,
    error: {
      code: "COMMAND_FAILED",
      message: error instanceof Error ? error.message : String(error),
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
  socket = new WebSocket(bridgeUrl);
  socket.addEventListener("open", () => {
    send({ type: "hello", deviceId, url: location.href, title: document.title });
  });
  socket.addEventListener("message", (event) => {
    try {
      const request = JSON.parse(String(event.data)) as AgentRequest;
      void execute(request).catch((error) => failure(request.id, error));
    } catch (error) {
      console.error("Remote Page Agent message error", error);
    }
  });
  socket.addEventListener("close", () => window.setTimeout(connect, 3000));
}

for (const method of ["log", "warn", "error"] as const) {
  const original = console[method];
  console[method] = (...args: unknown[]) => {
    original(...args);
    send({ type: "console", method, args: args.map(String), url: location.href });
  };
}

connect();
