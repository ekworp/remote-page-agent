// @ts-nocheck

const nodesById = new Map();
const idsByNode = new WeakMap();
let nextBackendNodeId = 1;
let accessibilityTreeCache: unknown[] | undefined;
const CONSOLE_MESSAGE_TYPE = "remote-page-agent-console";
const NAVIGATION_MESSAGE_TYPE = "remote-page-agent-navigation";
let consoleLevel = "warn";
const EVENT_WINDOW_MS = 10_000;
const MAX_CONSOLE_EVENTS = 50;
const MAX_PAGE_EVENTS = 20;
let consoleWindowStarted = 0;
let consoleWindowCount = 0;
let pageWindowStarted = 0;
let pageWindowCount = 0;

function allowEvent(kind) {
  const now = Date.now();
  if (kind === "console") {
    if (now - consoleWindowStarted >= EVENT_WINDOW_MS) {
      consoleWindowStarted = now;
      consoleWindowCount = 0;
    }
    if (consoleWindowCount >= MAX_CONSOLE_EVENTS) return false;
    consoleWindowCount += 1;
    return true;
  }
  if (now - pageWindowStarted >= EVENT_WINDOW_MS) {
    pageWindowStarted = now;
    pageWindowCount = 0;
  }
  if (pageWindowCount >= MAX_PAGE_EVENTS) return false;
  pageWindowCount += 1;
  return true;
}

function consoleLevelAllows(method) {
  if (consoleLevel === "off") return false;
  if (consoleLevel === "error") return method === "error";
  if (consoleLevel === "warn") return method === "warn" || method === "error";
  return true;
}

void chrome.storage.local
  .get({ consoleLevel: "warn" })
  .then((values) => {
    if (["all", "warn", "error", "off"].includes(values.consoleLevel)) {
      consoleLevel = values.consoleLevel;
    }
  })
  .catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.consoleLevel) return;
  if (["all", "warn", "error", "off"].includes(changes.consoleLevel.newValue)) {
    consoleLevel = changes.consoleLevel.newValue;
  }
});

function consumePageIdFragment() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has("remote-page-agent-page")) return "";
  const pageId = params.get("remote-page-agent-page") || "";
  const originalHash = params.get("remote-page-agent-original-hash");
  try {
    const cleanUrl = `${location.pathname}${location.search}${originalHash ? `#${originalHash}` : ""}`;
    history.replaceState(history.state, document.title, cleanUrl);
  } catch {
    // The URL may be unavailable during very early document startup.
  }
  return pageId;
}

const initialPageId = consumePageIdFragment();
let pageId = initialPageId;

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type === NAVIGATION_MESSAGE_TYPE) {
    announceNavigation();
    return;
  }
  if (event.data?.type !== CONSOLE_MESSAGE_TYPE) return;
  const { method, args, url } = event.data;
  if (!(["log", "warn", "error"] as const).includes(method)) return;
  if (!consoleLevelAllows(method)) return;
  if (!Array.isArray(args) || typeof url !== "string") return;
  if (!allowEvent("console")) return;
  send({ type: "console", method, args: args.map(String), url });
});

function backendNodeIdFor(element) {
  const existingId = idsByNode.get(element);
  if (existingId) return existingId;
  const id = nextBackendNodeId++;
  idsByNode.set(element, id);
  nodesById.set(id, element);
  return id;
}

function pruneBackendNodes() {
  for (const [id, element] of nodesById) {
    if (!element.isConnected) nodesById.delete(id);
  }
}

function elementByBackendNodeId(value) {
  const element = nodesById.get(Number(value));
  if (!element?.isConnected) throw new Error(`DOM node not found: ${value}`);
  return element;
}

function roleFor(element) {
  const explicitRole = element.getAttribute("role");
  if (explicitRole) return explicitRole.split(" ")[0];
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "a" && element.href) return "link";
  if (tag === "button") return "button";
  if (tag === "input" || tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "img") return "image";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "li") return "listitem";
  return "generic";
}

function nameFor(element) {
  const label =
    element.getAttribute("aria-label") ||
    element.getAttribute("alt") ||
    element.getAttribute("title");
  if (label) return label.replace(/\s+/g, " ").trim().slice(0, 500);
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element.placeholder) return element.placeholder;
  }
  const role = roleFor(element);
  if (role === "generic" || role === "none" || role === "presentation") {
    return Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000);
  }
  return (element instanceof HTMLElement ? element.innerText : "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function propertiesFor(element) {
  const properties = [];
  const add = (name, value) => properties.push({ name, value: { type: typeof value, value } });
  const expanded = element.getAttribute("aria-expanded");
  const disabled = element.getAttribute("aria-disabled");
  if (expanded === "true" || expanded === "false") add("expanded", expanded === "true");
  if (disabled === "true" || ("disabled" in element && element.disabled)) add("disabled", true);
  if (element instanceof HTMLAnchorElement && element.href) add("url", element.href);
  if (element instanceof HTMLElement && element.tabIndex >= 0) add("focusable", true);
  return properties;
}

function isHiddenFromAccessibilityTree(element) {
  if (element instanceof HTMLInputElement && element.type === "hidden") return true;
  if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") {
    return true;
  }
  const checkVisibility = element.checkVisibility;
  if (typeof checkVisibility === "function") {
    return !checkVisibility.call(element, {
      checkOpacity: false,
      checkVisibilityCSS: true,
    });
  }
  const style = getComputedStyle(element);
  return (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    style.contentVisibility === "hidden"
  );
}

function accessibilityTree() {
  if (accessibilityTreeCache) return accessibilityTreeCache;
  pruneBackendNodes();
  const nodes = [];
  const maxNodes = 3000;
  const visit = (element, level) => {
    if (nodes.length >= maxNodes) return [];
    if (!(element instanceof Element) || isHiddenFromAccessibilityTree(element)) return [];
    const id = String(backendNodeIdFor(element));
    const role = roleFor(element);
    const name = nameFor(element);
    const childIds =
      level >= 32 ? [] : Array.from(element.children).flatMap((child) => visit(child, level + 1));
    if (!name && (role === "generic" || role === "none" || role === "presentation"))
      return childIds;
    const node = {
      nodeId: id,
      backendNodeId: Number(id),
      backendDOMNodeId: Number(id),
      ignored: false,
      role: { type: "role", value: role },
      properties: propertiesFor(element),
      childIds,
    };
    if (name) node.name = { type: "computedString", value: name };
    nodes.push(node);
    return [id];
  };
  const root = {
    nodeId: "root",
    backendNodeId: 0,
    backendDOMNodeId: 0,
    ignored: false,
    role: { type: "role", value: "RootWebArea" },
    name: { type: "computedString", value: document.title },
    properties: [],
    childIds: [],
  };
  nodes.push(root);
  if (document.body) root.childIds = visit(document.body, 0);
  accessibilityTreeCache = nodes;
  return accessibilityTreeCache;
}

new MutationObserver(() => {
  accessibilityTreeCache = undefined;
}).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

function domSummary() {
  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || "").replace(/\s+/g, " ").trim(),
    links: Array.from(document.querySelectorAll("a[href]"))
      .slice(0, 100)
      .map((element) => ({ text: element.innerText.trim().slice(0, 200), href: element.href })),
    buttons: Array.from(document.querySelectorAll("button"))
      .slice(0, 100)
      .map((element) => element.innerText.trim().slice(0, 200)),
    inputs: Array.from(document.querySelectorAll("input, textarea, select"))
      .slice(0, 100)
      .map((element) => ({
        type: element.type || element.tagName.toLowerCase(),
        name: element.name || "",
        placeholder: element.placeholder || "",
        value: element.type === "password" ? "" : element.value || "",
      })),
  };
}

function clickTarget(element) {
  if (element.matches("a[href], button, input, textarea, select, [role=button], [role=link]"))
    return element;
  return (
    element.closest("a[href], button, input, textarea, select, [role=button], [role=link]") ||
    element
  );
}

function describeElement(element) {
  return {
    backendNodeId: backendNodeIdFor(element),
    tagName: element.tagName.toLowerCase(),
    className: typeof element.className === "string" ? element.className.slice(0, 120) : undefined,
  };
}

function rectSnapshot(rect) {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  };
}

function domRect(element) {
  return rectSnapshot(element.getBoundingClientRect());
}

function editableTarget(element) {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  )
    return element;
  return element.querySelector("input, textarea, select, [contenteditable=true]") || element;
}

function isEditable(element) {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

function fillElement(element, value) {
  if (!isEditable(element)) throw new Error("Element is not editable");
  if (
    element instanceof HTMLInputElement &&
    (element.type === "checkbox" || element.type === "radio")
  ) {
    element.checked = Boolean(value);
  } else if (element instanceof HTMLSelectElement) {
    element.value = Array.isArray(value) ? String(value[0] ?? "") : String(value);
  } else if ("value" in element) {
    element.value = String(value);
  } else {
    element.innerText = String(value);
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    value:
      element instanceof HTMLInputElement && element.type === "password"
        ? ""
        : (element.value ?? element.innerText),
    ...describeElement(element),
  };
}

function insertText(text) {
  const element = document.activeElement;
  if (!element || !isEditable(element)) throw new Error("Active element is not editable");
  if ("value" in element) element.value += text;
  else element.innerText += text;
  element.dispatchEvent(
    new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }),
  );
  return { value: element.value ?? element.innerText, ...describeElement(element) };
}

function domNode(element, depth = 0) {
  const node = {
    nodeId: String(backendNodeIdFor(element)),
    backendNodeId: backendNodeIdFor(element),
    nodeName: element.nodeName,
    localName: element.localName,
    nodeValue: element.nodeValue,
    childNodeCount: element.childNodes.length,
  };
  if (depth > 0)
    node.children = Array.from(element.children).map((child) => domNode(child, depth - 1));
  return node;
}

function clickByText(text) {
  const interactiveSelector =
    "a[href], button, input, textarea, select, [role=button], [role=link]";
  const candidate =
    Array.from(document.querySelectorAll(interactiveSelector)).find(
      (element) =>
        element.innerText?.trim() === text || element.getAttribute("aria-label") === text,
    ) ||
    Array.from(document.querySelectorAll("body *")).find(
      (element) => element.innerText?.trim() === text,
    );
  if (!candidate) throw new Error(`text not found: ${text}`);
  const target = clickTarget(candidate);
  target.scrollIntoView({ block: "center", inline: "center" });
  target.click();
  return { clicked: true, text, ...describeElement(target) };
}

function dispatchInput(payload) {
  const selector = typeof payload.selector === "string" ? payload.selector : "";
  const element =
    (selector ? document.querySelector(selector) : null) ||
    document.elementFromPoint(Number(payload.x ?? 0), Number(payload.y ?? 0)) ||
    document.body;
  if (!(element instanceof Element)) throw new Error("input target not found");
  if (payload.type === "keyDown" || payload.type === "keyUp" || payload.type === "char") {
    element.dispatchEvent(
      new KeyboardEvent(
        payload.type === "keyUp" ? "keyup" : payload.type === "char" ? "keypress" : "keydown",
        {
          bubbles: true,
          cancelable: true,
          key: String(payload.key ?? ""),
          code: String(payload.code ?? ""),
        },
      ),
    );
  } else if (payload.type === "mouseMoved") {
    element.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        clientX: Number(payload.x ?? 0),
        clientY: Number(payload.y ?? 0),
      }),
    );
  } else if (payload.type === "mousePressed") {
    clickTarget(element).dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: Number(payload.x ?? 0),
        clientY: Number(payload.y ?? 0),
        button: Number(payload.button ?? 0),
      }),
    );
  } else if (payload.type === "mouseReleased") {
    const target = clickTarget(element);
    target.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        clientX: Number(payload.x ?? 0),
        clientY: Number(payload.y ?? 0),
        button: Number(payload.button ?? 0),
      }),
    );
    target.click();
  } else if (payload.type === "mouseWheel") {
    element.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        deltaX: Number(payload.deltaX ?? 0),
        deltaY: Number(payload.deltaY ?? 0),
      }),
    );
  }
  return { type: payload.type || "click", ...describeElement(element) };
}

function safeEvaluation(code) {
  const normalized = String(code).replace(/\s+/g, "");
  if (
    normalized.includes("document.body?.innerText") ||
    normalized.includes("document.body.innerText")
  ) {
    return { result: document.body?.innerText ?? "NO BODY", resultType: "string" };
  }
  if (normalized.includes("document.title"))
    return { result: document.title, resultType: "string" };
  if (normalized.includes("location.href")) return { result: location.href, resultType: "string" };
  throw new Error("This page blocks dynamic JavaScript evaluation; use a fixed command instead.");
}

function waitForStableDom(quietMs = 100) {
  const delay = Math.max(0, Math.min(Number.isFinite(quietMs) ? quietMs : 100, 5000));
  return new Promise((resolve) => {
    let timer = 0;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, delay);
    });
    function done() {
      clearTimeout(timer);
      observer.disconnect();
      resolve({ stable: true, quietMs: delay });
    }
    timer = setTimeout(done, delay);
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  });
}

async function commandResult(message) {
  const payload = message.payload || {};
  switch (message.type) {
    case "get_page_info":
      return { title: document.title, url: location.href };
    case "query": {
      const element = document.querySelector(String(payload.selector || ""));
      if (!element) throw new Error(`Element not found: ${payload.selector}`);
      return { text: element.textContent || "", html: element.outerHTML };
    }
    case "click": {
      const element = document.querySelector(String(payload.selector || ""));
      if (!element) throw new Error(`Element not found: ${payload.selector}`);
      const target = clickTarget(element);
      target.scrollIntoView({ block: "center", inline: "center" });
      target.click();
      return { clicked: true, ...describeElement(target) };
    }
    case "click_text":
      return clickByText(String(payload.text || "").trim());
    case "input": {
      const element = editableTarget(document.querySelector(String(payload.selector || "")));
      if (!element) throw new Error(`Element not found: ${payload.selector}`);
      return fillElement(element, payload.value);
    }
    case "insert_text":
      return insertText(String(payload.text || ""));
    case "scroll":
      window.scrollBy(Number(payload.x || 0), Number(payload.y || 600));
      return { x: window.scrollX, y: window.scrollY };
    case "get_dom_summary":
      return domSummary();
    case "wait_for_stable_dom":
      return await waitForStableDom(Number(payload.quietMs ?? 100));
    case "get_accessibility_tree":
      return accessibilityTree();
    case "navigate":
      if (typeof payload.url !== "string") throw new Error("url is required");
      setTimeout(() => {
        location.href = payload.url;
      }, 0);
      return { url: payload.url };
    case "history_back":
      setTimeout(() => history.back(), 0);
      return { ok: true };
    case "reload":
      setTimeout(() => location.reload(), 0);
      return { ok: true };
    case "stop_loading":
      window.stop();
      return { ok: true };
    case "dispatch_input":
      return dispatchInput(payload);
    case "click_backend_node": {
      const target = clickTarget(elementByBackendNodeId(payload.backendNodeId));
      target.scrollIntoView({ block: "center", inline: "center" });
      target.click();
      return {
        clicked: true,
        backendNodeId: Number(payload.backendNodeId),
        ...describeElement(target),
      };
    }
    case "get_dom_rect":
      return domRect(clickTarget(elementByBackendNodeId(payload.backendNodeId)));
    case "get_dom_node": {
      const element = elementByBackendNodeId(payload.backendNodeId);
      return domNode(element, Number(payload.depth || 0));
    }
    case "get_dom_document":
      return document.documentElement
        ? domNode(document.documentElement, Number(payload.depth ?? 4))
        : null;
    case "dom_query": {
      const element = document.querySelector(String(payload.selector || ""));
      return element
        ? {
            nodeId: backendNodeIdFor(element),
            backendNodeId: backendNodeIdFor(element),
            html: element.outerHTML,
          }
        : { nodeId: 0, html: "" };
    }
    case "dom_outer_html":
      return elementByBackendNodeId(payload.backendNodeId).outerHTML;
    case "eval_safe":
      return safeEvaluation(payload.code);
    case "dom_operation": {
      if (payload.operation === "document_size") {
        return {
          documentWidth: document.documentElement.clientWidth,
          documentHeight: document.documentElement.clientHeight,
        };
      }
      const source = elementByBackendNodeId(payload.backendNodeId);
      const element = clickTarget(source);
      switch (payload.operation) {
        case "click":
          element.scrollIntoView({ block: "center", inline: "center" });
          element.click();
          return {
            clicked: true,
            backendNodeId: backendNodeIdFor(element),
            ...describeElement(element),
          };
        case "fill":
        case "set_value":
          return fillElement(editableTarget(source), payload.value ?? "");
        case "select_option":
          if (!(source instanceof HTMLSelectElement)) throw new Error("Element is not a select");
          source.value = String(
            Array.isArray(payload.values) ? (payload.values[0] ?? "") : (payload.value ?? ""),
          );
          source.dispatchEvent(new Event("input", { bubbles: true }));
          source.dispatchEvent(new Event("change", { bubbles: true }));
          return { value: source.value, ...describeElement(source) };
        case "rect":
          return domRect(element);
        case "client_rects":
          return Array.from(element.getClientRects(), rectSnapshot);
        case "stable_rects":
          return [domRect(element), domRect(element)];
        case "is_intersecting": {
          const rect = element.getBoundingClientRect();
          return (
            rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
          );
        }
        case "assert_connected":
          return source.isConnected ? null : "Node is detached from document";
        case "is_svg":
          return element instanceof SVGElement;
        case "scroll_into_view":
          element.scrollIntoView({ block: "center", inline: "center" });
          return { scrolled: true, rect: domRect(element), ...describeElement(element) };
        case "focus":
          editableTarget(source).focus();
          return { focused: true, ...describeElement(editableTarget(source)) };
        case "get_value":
          return editableTarget(source).value ?? editableTarget(source).innerText ?? "";
        case "get_input_kind": {
          const editable = editableTarget(source);
          if (editable instanceof HTMLSelectElement) return "select";
          if (editable instanceof HTMLTextAreaElement) return "typeable-input";
          if (editable instanceof HTMLInputElement) {
            return editable.type === "checkbox" || editable.type === "radio"
              ? "checkable-input"
              : "typeable-input";
          }
          return editable instanceof HTMLElement && editable.isContentEditable
            ? "contenteditable"
            : "unsupported";
        }
        case "get_enabled":
          return !editableTarget(source).disabled;
        case "is_checkable":
          return source instanceof HTMLInputElement && ["checkbox", "radio"].includes(source.type);
        case "get_checked":
          return source instanceof HTMLInputElement
            ? source.checked
            : source.getAttribute("aria-checked") === "true";
        case "inspect_element": {
          const editable = editableTarget(source);
          return {
            ...describeElement(editable),
            connected: editable.isConnected,
            editable: isEditable(editable),
            rect: domRect(editable),
            disabled: Boolean(editable.disabled),
            placeholder: editable.placeholder || "",
          };
        }
        case "attributes":
          return Array.from(source.attributes).flatMap((attribute) => [
            attribute.name,
            attribute.value,
          ]);
        case "local_name":
          return source.localName;
        case "outer_html":
          return source.outerHTML;
        case "parent":
          return source.parentElement
            ? { backendNodeId: backendNodeIdFor(source.parentElement) }
            : null;
        default:
          throw new Error(`Unsupported DOM operation: ${payload.operation}`);
      }
    }
    default:
      throw new Error(`Unsupported extension command: ${message.type}`);
  }
}

let extensionContextInvalidated = false;

function send(message) {
  if (extensionContextInvalidated) return;
  try {
    void chrome.runtime.sendMessage({ type: "agent_message", message }).catch(() => {
      extensionContextInvalidated = true;
    });
  } catch {
    // The extension may have been reloaded while this document was open.
    extensionContextInvalidated = true;
  }
}

let bridgeReady = false;
let contentReadySent = false;
let lastAnnouncedUrl = "";
let lastAnnouncedTitle = "";

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "bridge_ready") {
    if (typeof message.pageId === "string" && message.pageId) pageId = message.pageId;
    bridgeReady = true;
    announce();
    return;
  }
  if (message?.type !== "bridge_message") return;
  const request = message.message;
  if (request.type === "hello_ack") return;
  if (typeof request.id !== "string") return;
  try {
    void Promise.resolve(commandResult(request)).then(
      (result) => send({ id: request.id, type: request.type, ok: true, result }),
      (error) =>
        send({
          id: request.id,
          type: request.type,
          ok: false,
          error: { message: error instanceof Error ? error.message : String(error) },
        }),
    );
  } catch (error) {
    send({
      id: request.id,
      type: request.type,
      ok: false,
      error: { code: "COMMAND_FAILED", message: String(error.message || error) },
    });
  }
});

function announce() {
  if (!contentReadySent) {
    if (extensionContextInvalidated) return;
    try {
      void chrome.runtime
        .sendMessage({ type: "content_ready", pageId: initialPageId || undefined })
        .catch(() => {
          extensionContextInvalidated = true;
        });
    } catch {
      extensionContextInvalidated = true;
      return;
    }
    contentReadySent = true;
  }
  if (!bridgeReady) return;
  if (location.href === lastAnnouncedUrl && document.title === lastAnnouncedTitle) return;
  lastAnnouncedUrl = location.href;
  lastAnnouncedTitle = document.title;
  pageEvent("Page.frameNavigated", {
    frame: { id: pageId || location.href, url: location.href },
  });
}

function pageEvent(method, params = {}) {
  if (!bridgeReady) return;
  if (!allowEvent("page")) return;
  send({ type: "page_event", method, params, url: location.href, title: document.title });
}

function announceNavigation() {
  if (!bridgeReady) return;
  if (location.href === lastAnnouncedUrl && document.title === lastAnnouncedTitle) return;
  const frameId = pageId || location.href;
  pageEvent("Page.frameNavigated", {
    frame: {
      id: frameId,
      url: location.href,
      securityOrigin: location.origin,
      mimeType: "text/html",
    },
  });
  pageEvent("Page.navigatedWithinDocument", { frameId, url: location.href });
  pageEvent("Page.lifecycleEvent", {
    frameId,
    loaderId: frameId,
    name: "load",
    timestamp: Date.now() / 1000,
  });
  lastAnnouncedUrl = location.href;
  lastAnnouncedTitle = document.title;
}

window.addEventListener(
  "load",
  () => {
    announce();
    pageEvent("Page.loadEventFired", { timestamp: Date.now() / 1000 });
    pageEvent("Page.lifecycleEvent", {
      frameId: pageId || location.href,
      loaderId: pageId || location.href,
      name: "load",
      timestamp: Date.now() / 1000,
    });
  },
  { once: true },
);
window.addEventListener("offline", () => pageEvent("Network.offline", { online: false }));
window.addEventListener("online", () => pageEvent("Network.online", { online: true }));
window.addEventListener("pageshow", announceNavigation);
let observedTitle = null;
const titleObserver = new MutationObserver(announceNavigation);
const observeTitle = () => {
  const title = document.querySelector("title");
  if (!title || title === observedTitle) return;
  observedTitle = title;
  titleObserver.observe(title, { childList: true, characterData: true, subtree: true });
  announceNavigation();
};
observeTitle();
if (document.head) {
  new MutationObserver(observeTitle).observe(document.head, { childList: true });
}
if ("navigation" in window) {
  window.navigation.addEventListener("navigatesuccess", announceNavigation);
}
announce();
