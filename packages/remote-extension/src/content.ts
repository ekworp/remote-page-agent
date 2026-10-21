// @ts-nocheck

const nodesById = new Map();
let nextBackendNodeId = 1;

function backendNodeIdFor(element) {
  for (const [id, node] of nodesById) {
    if (node === element) return id;
  }
  const id = nextBackendNodeId++;
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

function accessibilityTree() {
  pruneBackendNodes();
  const nodes = [];
  const maxNodes = 3000;
  const visit = (element, level) => {
    if (nodes.length >= maxNodes) return [];
    if (
      !(element instanceof Element) ||
      element.hasAttribute("hidden") ||
      element.getAttribute("aria-hidden") === "true"
    )
      return [];
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
  return nodes;
}

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
  const candidate = Array.from(document.querySelectorAll("body *")).find(
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

function commandResult(message) {
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
        case "get_input_kind":
          if (source instanceof HTMLSelectElement) return "select";
          if (source instanceof HTMLTextAreaElement) return "typeable-input";
          if (source instanceof HTMLInputElement) return source.type;
          return source instanceof HTMLElement && source.isContentEditable
            ? "contenteditable"
            : "unsupported";
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
        case "document_size":
          return {
            documentWidth: document.documentElement.clientWidth,
            documentHeight: document.documentElement.clientHeight,
          };
        default:
          throw new Error(`Unsupported DOM operation: ${payload.operation}`);
      }
    }
    default:
      throw new Error(`Unsupported extension command: ${message.type}`);
  }
}

function send(message) {
  chrome.runtime.sendMessage({ type: "agent_message", message });
}

let bridgeReady = false;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "bridge_ready") {
    bridgeReady = true;
    announce();
    return;
  }
  if (message?.type !== "bridge_message") return;
  const request = message.message;
  if (request.type === "hello_ack") return;
  if (typeof request.id !== "string") return;
  try {
    send({ id: request.id, type: request.type, ok: true, result: commandResult(request) });
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
  chrome.runtime.sendMessage({ type: "content_ready" });
  if (!bridgeReady) return;
  send({
    type: "page_event",
    method: "Page.frameNavigated",
    params: { frame: { id: location.href, url: location.href } },
    url: location.href,
    title: document.title,
  });
}

window.addEventListener("load", announce, { once: true });
announce();
