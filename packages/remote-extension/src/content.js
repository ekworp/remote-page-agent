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
  const nodes = [];
  const visit = (element, level) => {
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

function commandResult(message) {
  const payload = message.payload || {};
  switch (message.type) {
    case "get_page_info":
      return { title: document.title, url: location.href };
    case "get_dom_summary":
      return domSummary();
    case "get_accessibility_tree":
      return accessibilityTree();
    case "get_dom_node": {
      const element = elementByBackendNodeId(payload.backendNodeId);
      return {
        nodeId: String(payload.backendNodeId),
        backendNodeId: Number(payload.backendNodeId),
        nodeName: element.nodeName,
        localName: element.localName,
        nodeValue: element.nodeValue,
        childNodeCount: element.childNodes.length,
      };
    }
    case "dom_query": {
      const element = document.querySelector(String(payload.selector || ""));
      return element ? { backendNodeId: backendNodeIdFor(element) } : null;
    }
    case "dom_outer_html":
      return elementByBackendNodeId(payload.backendNodeId).outerHTML;
    case "dom_operation": {
      const element = clickTarget(elementByBackendNodeId(payload.backendNodeId));
      switch (payload.operation) {
        case "click":
          element.scrollIntoView({ block: "center", inline: "center" });
          element.click();
          return { clicked: true, backendNodeId: backendNodeIdFor(element) };
        case "fill":
        case "set_value":
          if (!("value" in element)) throw new Error("Element does not support a value");
          element.value = String(payload.value ?? "");
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return { value: element.value, backendNodeId: backendNodeIdFor(element) };
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

chrome.runtime.onMessage.addListener((message) => {
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
