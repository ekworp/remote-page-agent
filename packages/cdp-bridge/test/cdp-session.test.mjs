import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { WebSocket } from "ws";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForBridge(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // The server is still starting.
    }
    await sleep(100);
  }
  throw new Error("CDP bridge did not start");
}

async function startBridge(t, extraEnv = {}) {
  const port = await freePort();
  const bridge = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, ...extraEnv, PORT: String(port) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  t.after(() => bridge.kill("SIGTERM"));
  const version = await waitForBridge(port);
  return { port, version };
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

test("CDP sessions receive execution contexts and evaluate functions", async (t) => {
  const { port, version } = await startBridge(t);

  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent`);
  t.after(() => agent.close());
  agent.on("open", () => {
    agent.send(
      JSON.stringify({
        type: "hello",
        browserId: "browser-1",
        pageId: "page-1",
        url: "https://example.com/",
        title: "Example",
      }),
    );
  });
  agent.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type !== "eval_safe") return;
    const code = message.payload?.code ?? "";
    if (code.includes("document.title")) {
      agent.send(
        JSON.stringify({
          id: message.id,
          ok: true,
          resultType: "function",
          functionSource: '() => "Example"',
        }),
      );
      return;
    }
    agent.send(
      JSON.stringify({ id: message.id, ok: true, result: '"Example"', resultType: "string" }),
    );
  });
  await waitForOpen(agent);
  await sleep(50);

  const cdp = new WebSocket(version.webSocketDebuggerUrl);
  t.after(() => cdp.close());
  await waitForOpen(cdp);

  let requestId = 0;
  const responses = new Map();
  const events = [];
  cdp.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id) responses.set(message.id, message);
    else events.push(message);
  });

  const send = (method, params = {}, sessionId) => {
    requestId += 1;
    const id = requestId;
    cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const response = responses.get(id);
        if (!response) return;
        clearInterval(timer);
        if (response.error) reject(new Error(JSON.stringify(response.error)));
        else resolve(response.result);
      }, 5);
    });
  };

  await send("Target.setDiscoverTargets", { discover: true });
  await send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{}],
  });
  await sleep(50);
  const attached = events.find((event) => event.method === "Target.attachedToTarget");
  assert.ok(attached, "expected a Target.attachedToTarget event");
  const sessionId = attached.params.sessionId;

  await send("Runtime.enable", {}, sessionId);
  const contextEvent = events.find(
    (event) => event.method === "Runtime.executionContextCreated" && event.sessionId === sessionId,
  );
  assert.ok(contextEvent, "executionContextCreated must be scoped to the session");
  assert.equal(contextEvent.params.context.auxData.frameId, "page-1");
  assert.equal(contextEvent.params.context.auxData.isDefault, true);

  const eventCount = events.length;
  await send(
    "Target.setAutoAttach",
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{}] },
    sessionId,
  );
  await sleep(100);
  assert.equal(
    events.slice(eventCount).filter((event) => event.method === "Target.attachedToTarget").length,
    0,
    "session-level setAutoAttach must not recursively attach the page",
  );

  const evaluated = await send(
    "Runtime.evaluate",
    { expression: "(() => document.title)", returnByValue: false, awaitPromise: true },
    sessionId,
  );
  assert.ok(evaluated.result.objectId, "function results need a CDP objectId");

  const called = await send(
    "Runtime.callFunctionOn",
    {
      functionDeclaration: "async (fn) => JSON.stringify(await fn())",
      executionContextId: contextEvent.params.context.id,
      arguments: [{ objectId: evaluated.result.objectId }],
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );
  assert.equal(called.result.value, '"Example"');

  const direct = await send(
    "Runtime.callFunctionOn",
    {
      functionDeclaration: '() => "Example"',
      executionContextId: contextEvent.params.context.id,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );
  assert.equal(direct.result.value, '"Example"');
});

test("AX uid resolves to a DOM handle and click dispatches mouse events", async (t) => {
  const { port, version } = await startBridge(t);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent`);
  t.after(() => agent.close());
  const clicks = [];
  let pageUrl = "https://example.com/";

  agent.on("open", () => {
    agent.send(
      JSON.stringify({
        type: "hello",
        browserId: "browser-1",
        pageId: "page-1",
        url: pageUrl,
        title: "Example",
      }),
    );
  });
  agent.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type !== "dom_operation" && message.type !== "dispatch_input") {
      if (message.type === "get_accessibility_tree") {
        agent.send(
          JSON.stringify({
            id: message.id,
            ok: true,
            result: [
              {
                nodeId: "root",
                backendDOMNodeId: 0,
                backendNodeId: 0,
                ignored: false,
                role: { type: "role", value: "RootWebArea" },
                properties: [],
                childIds: ["42"],
              },
              {
                nodeId: "42",
                backendDOMNodeId: 42,
                backendNodeId: 42,
                ignored: false,
                role: { type: "role", value: "button" },
                name: { type: "computedString", value: "Close" },
                properties: [],
                childIds: [],
              },
            ],
          }),
        );
        return;
      }
      if (message.type === "get_dom_node") {
        agent.send(
          JSON.stringify({
            id: message.id,
            ok: true,
            result: {
              nodeId: 42,
              backendNodeId: 42,
              nodeType: 1,
              nodeName: "BUTTON",
              localName: "button",
              frameId: "page-1",
              attributes: [],
            },
          }),
        );
        return;
      }
      agent.send(JSON.stringify({ id: message.id, ok: true, result: {} }));
      return;
    }
    if (message.type === "dispatch_input") {
      clicks.push(message.payload);
      if (message.payload?.type === "mouseReleased") {
        pageUrl = "https://example.com/after-click";
        agent.send(
          JSON.stringify({
            type: "page_event",
            method: "Page.frameNavigated",
            params: {
              frame: {
                id: "page-1",
                url: pageUrl,
                securityOrigin: "https://example.com",
                mimeType: "text/html",
              },
            },
            url: pageUrl,
            title: "After click",
          }),
        );
      }
      agent.send(JSON.stringify({ id: message.id, ok: true, result: { ok: true } }));
      return;
    }
    const operation = message.payload?.operation;
    const results = {
      assert_connected: null,
      is_intersecting: true,
      is_svg: false,
      client_rects: [{ x: 10, y: 20, width: 100, height: 40 }],
      rect: { x: 10, y: 20, width: 100, height: 40 },
      document_size: { documentWidth: 390, documentHeight: 844 },
      local_name: "button",
    };
    if (operation === "click") {
      clicks.push({ operation: "click", backendNodeId: message.payload.backendNodeId });
      pageUrl = "https://example.com/after-click";
      agent.send(
        JSON.stringify({
          type: "page_event",
          method: "Page.frameNavigated",
          params: {
            frame: {
              id: "page-1",
              url: pageUrl,
              securityOrigin: "https://example.com",
              mimeType: "text/html",
            },
          },
          url: pageUrl,
          title: "After click",
        }),
      );
    }
    agent.send(
      JSON.stringify({
        id: message.id,
        ok: true,
        result: operation in results ? results[operation] : { ok: true },
      }),
    );
  });
  await waitForOpen(agent);
  await sleep(50);

  const cdp = new WebSocket(version.webSocketDebuggerUrl);
  t.after(() => cdp.close());
  await waitForOpen(cdp);

  let requestId = 0;
  const responses = new Map();
  const events = [];
  cdp.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id) responses.set(message.id, message);
    else events.push(message);
  });

  const send = (method, params = {}, sessionId) => {
    requestId += 1;
    const id = requestId;
    cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const response = responses.get(id);
        if (!response) return;
        clearInterval(timer);
        if (response.error) reject(new Error(JSON.stringify(response.error)));
        else resolve(response.result);
      }, 5);
    });
  };

  await send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{}],
  });
  await sleep(50);
  const attached = events.find((event) => event.method === "Target.attachedToTarget");
  assert.ok(attached, "expected a Target.attachedToTarget event");
  const sessionId = attached.params.sessionId;
  await send("Runtime.enable", {}, sessionId);
  const contextEvent = events.find(
    (event) => event.method === "Runtime.executionContextCreated" && event.sessionId === sessionId,
  );
  assert.ok(contextEvent);

  const ax = await send("Accessibility.getFullAXTree", {}, sessionId);
  const button = ax.nodes.find((node) => node.role?.value === "button");
  assert.ok(button, "expected one button in the AX tree");
  assert.equal(button.backendDOMNodeId, button.backendNodeId);
  const backendNodeId = button.backendDOMNodeId;

  const resolved = await send(
    "DOM.resolveNode",
    { backendNodeId, executionContextId: contextEvent.params.context.id },
    sessionId,
  );
  const objectId = resolved.object.objectId;
  assert.match(objectId, /^dom:42:/);

  const described = await send("DOM.describeNode", { objectId }, sessionId);
  assert.equal(described.node.backendNodeId, backendNodeId);

  const requests = await send("DOM.requestNode", { objectId }, sessionId);
  assert.equal(requests.nodeId, backendNodeId);

  const connected = await send(
    "Runtime.callFunctionOn",
    {
      functionDeclaration:
        "async element => { if (!element.isConnected) return 'Node is detached from document'; if (element.nodeType !== Node.ELEMENT_NODE) return 'Node is not of type HTMLElement'; return; }",
      arguments: [{ objectId }, {}],
      executionContextId: contextEvent.params.context.id,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );
  assert.equal(connected.result.value, null);

  const clientRects = await send(
    "Runtime.callFunctionOn",
    {
      functionDeclaration:
        "element => [...element.getClientRects()].map(rect => ({x: rect.x, y: rect.y, width: rect.width, height: rect.height}))",
      arguments: [{ objectId }, {}],
      executionContextId: contextEvent.params.context.id,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );
  assert.deepEqual(clientRects.result.value, [{ x: 10, y: 20, width: 100, height: 40 }]);

  const quads = await send("DOM.getContentQuads", { objectId }, sessionId);
  assert.deepEqual(quads.quads[0], [10, 20, 110, 20, 110, 60, 10, 60]);
  const box = await send("DOM.getBoxModel", { objectId }, sessionId);
  assert.equal(box.model.width, 100);

  await send("DOM.scrollIntoViewIfNeeded", { objectId }, sessionId);
  await send("DOM.focus", { objectId }, sessionId);
  assert.deepEqual(
    {
      x: (quads.quads[0][0] + quads.quads[0][4]) / 2,
      y: (quads.quads[0][1] + quads.quads[0][5]) / 2,
    },
    { x: 60, y: 40 },
  );

  await send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: 60, y: 40, button: "none" },
    sessionId,
  );
  await send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x: 60, y: 40, button: "left", clickCount: 1 },
    sessionId,
  );
  await send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x: 60, y: 40, button: "left", clickCount: 1 },
    sessionId,
  );
  assert.deepEqual(
    clicks.filter((item) => item.type).map((item) => item.type),
    ["mouseMoved", "mousePressed", "mouseReleased"],
  );
  assert.equal(
    clicks.filter((item) => item.type === "mouseReleased").length,
    1,
    "one release must produce exactly one activation",
  );

  await send(
    "Input.dispatchKeyEvent",
    { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    sessionId,
  );
  await send(
    "Input.dispatchKeyEvent",
    { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    sessionId,
  );
  assert.deepEqual(
    clicks
      .filter((item) => item.type === "keyDown" || item.type === "keyUp")
      .map((item) => item.type),
    ["keyDown", "keyUp"],
  );

  const navigated = events.find(
    (event) => event.method === "Page.frameNavigated" && event.sessionId === sessionId,
  );
  assert.ok(navigated, "agent page events should be forwarded to the page session");

  const targets = await send("Target.getTargets");
  assert.equal(targets.targetInfos[0].url, "https://example.com/after-click");
});

test("Puppeteer fill call shapes use fixed DOM input operations", async (t) => {
  const { port, version } = await startBridge(t);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent`);
  t.after(() => agent.close());
  const operations = [];
  const evalCalls = [];
  const kinds = new Map([
    [201, "typeable-input"],
    [202, "typeable-input"],
    [203, "select"],
    [204, "checkable-input"],
    [205, "checkable-input"],
    [206, "contenteditable"],
  ]);

  agent.on("open", () => {
    agent.send(
      JSON.stringify({
        type: "hello",
        browserId: "browser-1",
        pageId: "page-1",
        url: "https://example.test/",
        title: "Test page",
      }),
    );
  });
  agent.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    const reply = (result) => agent.send(JSON.stringify({ id: message.id, ok: true, result }));
    if (message.type === "get_dom_node") {
      reply({
        nodeId: Number(message.payload?.backendNodeId),
        backendNodeId: Number(message.payload?.backendNodeId),
        nodeType: 1,
        nodeName: "INPUT",
        localName: "input",
        frameId: "page-1",
        attributes: [],
      });
      return;
    }
    if (message.type === "eval_safe") {
      evalCalls.push(message.payload?.code);
      agent.send(
        JSON.stringify({
          id: message.id,
          ok: false,
          error: { message: "blocked dynamic eval" },
        }),
      );
      return;
    }
    if (message.type === "insert_text") {
      operations.push({ operation: "insert_text", value: message.payload?.text });
      reply({ value: message.payload?.text });
      return;
    }
    if (message.type === "dom_operation") {
      const backendNodeId = Number(message.payload?.backendNodeId);
      const operation = message.payload?.operation;
      operations.push({ operation, backendNodeId, payload: message.payload });
      if (operation === "get_input_kind") {
        reply(kinds.get(backendNodeId) ?? "typeable-input");
        return;
      }
      if (operation === "is_checkable") {
        reply(false);
        return;
      }
      if (operation === "get_checked") {
        reply(false);
        return;
      }
      if (operation === "fill" || operation === "set_value") {
        reply({
          value: message.payload?.value,
          tagName: kinds.get(backendNodeId) === "select" ? "select" : "input",
        });
        return;
      }
      if (operation === "select_option") {
        reply({ selected: message.payload?.values, tagName: "select" });
        return;
      }
      reply({ ok: true });
      return;
    }
    reply({ ok: true });
  });
  await waitForOpen(agent);
  await sleep(50);

  const cdp = new WebSocket(version.webSocketDebuggerUrl);
  t.after(() => cdp.close());
  await waitForOpen(cdp);

  let requestId = 0;
  const responses = new Map();
  const events = [];
  cdp.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id) responses.set(message.id, message);
    else events.push(message);
  });
  const send = (method, params = {}, sessionId) => {
    requestId += 1;
    const id = requestId;
    cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const response = responses.get(id);
        if (!response) return;
        clearInterval(timer);
        if (response.error) reject(new Error(JSON.stringify(response.error)));
        else resolve(response.result);
      }, 5);
    });
  };

  await send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{}],
  });
  await sleep(50);
  const attached = events.find((event) => event.method === "Target.attachedToTarget");
  assert.ok(attached);
  const sessionId = attached.params.sessionId;
  await send("Runtime.enable", {}, sessionId);
  const contextId = events.find(
    (event) => event.method === "Runtime.executionContextCreated" && event.sessionId === sessionId,
  ).params.context.id;

  const resolve = async (backendNodeId) => {
    const result = await send(
      "DOM.resolveNode",
      { backendNodeId, executionContextId: contextId },
      sessionId,
    );
    return result.object.objectId;
  };
  const call = (objectId, functionDeclaration, args) =>
    send(
      "Runtime.callFunctionOn",
      {
        functionDeclaration,
        executionContextId: contextId,
        arguments: [{ objectId }, ...args],
      },
      sessionId,
    );

  const typeProbe =
    "el => { if (el instanceof HTMLSelectElement) return 'select'; if (el instanceof HTMLTextAreaElement) return 'typeable-input'; if (el instanceof HTMLInputElement) return 'typeable-input'; if (el.isContentEditable) return 'contenteditable'; return 'unknown'; }";
  const toggleProbe =
    "el => { if (el instanceof HTMLInputElement) { return el.type === 'checkbox' || el.type === 'radio'; } const role = el.getAttribute('role'); return (role === 'checkbox' || role === 'radio' || role === 'switch'); }";
  const shortFill =
    "(input, newValue) => { const valString = String(newValue); const currentValue = input.value; if (currentValue === valString) return ''; if (!valString.startsWith(currentValue) || !currentValue) { input.value = ''; return valString; } input.value = ''; input.value = currentValue; return valString.substring(currentValue.length); }";
  const directFill =
    "(input, newValue) => { input.value = String(newValue); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }";
  const toggleState =
    "toggleEl => { if (toggleEl.indeterminate || toggleEl.getAttribute('aria-checked') === 'mixed') return 'mixed'; return toggleEl.checked || toggleEl.getAttribute('aria-checked') === 'true'; }";
  const selectOptions =
    "(element, vals) => { if (!(element instanceof HTMLSelectElement)) throw new Error('not select'); const values = new Set(vals); for (const option of element.options) { option.selected = values.has(option.value); } element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return [...values]; }";

  const inputId = await resolve(201);
  const inputKind = await call(inputId, typeProbe, []);
  assert.equal(inputKind.result.value, "typeable-input");

  const checkable = await call(inputId, toggleProbe, []);
  assert.equal(checkable.result.value, false);
  assert.ok(operations.some((item) => item.operation === "is_checkable"));

  const shortFillResult = await call(inputId, shortFill, [{ value: "焦虑抑郁" }]);
  assert.equal(shortFillResult.result.value, "");
  assert.ok(
    operations.some(
      (item) =>
        item.operation === "fill" &&
        item.backendNodeId === 201 &&
        item.payload.value === "焦虑抑郁",
    ),
    "short fill must use the fixed fill operation",
  );

  const textareaId = await resolve(202);
  await call(textareaId, directFill, [{ value: "多行文本" }]);
  assert.ok(
    operations.some(
      (item) =>
        item.operation === "fill" &&
        item.backendNodeId === 202 &&
        item.payload.value === "多行文本",
    ),
  );

  const selectId = await resolve(203);
  await call(selectId, selectOptions, [{ value: ["a", "b"] }]);
  assert.ok(
    operations.some(
      (item) =>
        item.operation === "select_option" &&
        item.backendNodeId === 203 &&
        JSON.stringify(item.payload.values) === JSON.stringify(["a", "b"]),
    ),
  );

  const checkboxId = await resolve(204);
  const checked = await call(checkboxId, toggleState, []);
  assert.equal(checked.result.value, false);

  const radioId = await resolve(205);
  const radioChecked = await call(radioId, toggleState, []);
  assert.equal(radioChecked.result.value, false);

  const contenteditableId = await resolve(206);
  await call(contenteditableId, shortFill, [{ value: "富文本" }]);
  assert.ok(
    operations.some(
      (item) =>
        item.operation === "fill" && item.backendNodeId === 206 && item.payload.value === "富文本",
    ),
  );

  await send("Input.insertText", { text: "抑郁" }, sessionId);
  assert.ok(operations.some((item) => item.operation === "insert_text" && item.value === "抑郁"));

  assert.equal(evalCalls.length, 0, "fill must not reach eval_safe");
  assert.ok(
    operations.some((item) => item.operation === "get_input_kind"),
    "fill must first probe the input kind using a fixed operation",
  );
});

test("page targets stay unique across connect, reconnect, navigation and close", async (t) => {
  const { port, version } = await startBridge(t, { PAGE_RECONNECT_GRACE_MS: "300" });
  const events = [];
  const responses = new Map();
  let requestId = 0;

  const cdp = new WebSocket(version.webSocketDebuggerUrl);
  t.after(() => cdp.close());
  cdp.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id) responses.set(message.id, message);
    else events.push(message);
  });
  await waitForOpen(cdp);
  const send = (method, params = {}, sessionId) => {
    requestId += 1;
    const id = requestId;
    cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const response = responses.get(id);
        if (!response) return;
        clearInterval(timer);
        if (response.error) reject(new Error(JSON.stringify(response.error)));
        else resolve(response.result);
      }, 5);
    });
  };
  const waitUntil = async (predicate, label, timeout = 2000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = predicate();
      if (value) return value;
      await sleep(20);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  await send("Target.setDiscoverTargets", { discover: true });
  await send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{}],
  });
  await sleep(100);

  const agents = [];
  const connectAgent = async (pageId, url, title) => {
    const agent = new WebSocket(`ws://127.0.0.1:${port}/agent`);
    const acked = [];
    agent.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "hello_ack") acked.push(message);
    });
    await waitForOpen(agent);
    agent.send(JSON.stringify({ type: "hello", browserId: "b1", pageId, url, title }));
    await sleep(80);
    agents.push(agent);
    return { agent, acked };
  };

  await connectAgent("page-a", "https://a.example/", "Page A");
  await waitUntil(
    () =>
      events.find(
        (event) =>
          event.method === "Target.targetCreated" &&
          event.params?.targetInfo?.targetId === "page-a",
      ),
    "targetCreated for page-a",
  );
  const attachedA = await waitUntil(
    () =>
      events.find(
        (event) =>
          event.method === "Target.attachedToTarget" &&
          event.params?.targetInfo?.targetId === "page-a",
      ),
    "attachedToTarget for page-a",
  );

  const second = await connectAgent("page-b", "https://b.example/", "Page B");
  const attachedB = await waitUntil(
    () =>
      events.find(
        (event) =>
          event.method === "Target.attachedToTarget" &&
          event.params?.targetInfo?.targetId === "page-b",
      ),
    "attachedToTarget for page-b",
  );

  let targets = await send("Target.getTargets");
  assert.deepEqual(targets.targetInfos.map((info) => info.targetId).sort(), ["page-a", "page-b"]);
  assert.equal(
    targets.targetInfos.find((info) => info.targetId === "page-b").url,
    "https://b.example/",
  );

  // Same tab navigation event must only reach that page's session.
  events.length = 0;
  second.agent.send(
    JSON.stringify({
      type: "page_event",
      method: "Page.frameNavigated",
      params: {
        frame: {
          id: "page-b",
          url: "https://b.example/next",
          securityOrigin: "https://b.example",
          mimeType: "text/html",
        },
      },
      url: "https://b.example/next",
      title: "Page B next",
    }),
  );
  const changedB = await waitUntil(
    () =>
      events.find(
        (event) =>
          event.method === "Target.targetInfoChanged" &&
          event.params?.targetInfo?.targetId === "page-b",
      ),
    "targetInfoChanged for page-b",
  );
  assert.equal(changedB.params.targetInfo.url, "https://b.example/next");
  const navigatedB = await waitUntil(
    () =>
      events.find(
        (event) =>
          event.method === "Page.frameNavigated" && event.sessionId === attachedB.params.sessionId,
      ),
    "Page.frameNavigated for page-b session",
  );
  assert.equal(navigatedB.params.frame.url, "https://b.example/next");
  assert.equal(
    events.some(
      (event) =>
        event.method === "Page.frameNavigated" && event.sessionId === attachedA.params.sessionId,
    ),
    false,
    "page-b navigation must not be routed to page-a",
  );

  // Reconnect within the grace period: same target, no duplicate creation.
  const createdBefore = events.filter(
    (event) =>
      event.method === "Target.targetCreated" && event.params?.targetInfo?.targetId === "page-b",
  ).length;
  second.agent.close();
  await sleep(100);
  second.agent = (
    await connectAgent("page-b", "https://b.example/after-reconnect", "Page B reconnected")
  ).agent;
  await sleep(150);
  assert.equal(
    events.filter(
      (event) =>
        event.method === "Target.targetCreated" && event.params?.targetInfo?.targetId === "page-b",
    ).length,
    createdBefore,
    "graceful reconnect must not create a duplicate target",
  );
  assert.equal(
    events.some(
      (event) => event.method === "Target.targetDestroyed" && event.params?.targetId === "page-b",
    ),
    false,
  );
  targets = await send("Target.getTargets");
  assert.equal(
    targets.targetInfos.find((info) => info.targetId === "page-b").url,
    "https://b.example/after-reconnect",
  );

  // A duplicated tab inherits sessionStorage. The live collision gets a new id.
  const collision = await connectAgent("page-a", "https://clone.example/", "Clone");
  assert.ok(collision.acked[0]?.pageId);
  assert.notEqual(collision.acked[0].pageId, "page-a");
  const cloneId = collision.acked[0].pageId;
  await waitUntil(
    () =>
      events.find(
        (event) =>
          event.method === "Target.targetCreated" && event.params?.targetInfo?.targetId === cloneId,
      ),
    "targetCreated for collision clone",
  );
  targets = await send("Target.getTargets");
  assert.deepEqual(
    targets.targetInfos.map((info) => info.targetId).sort(),
    ["page-a", "page-b", cloneId].sort(),
  );

  // Close past the grace period: exactly one destroy + session detach.
  events.length = 0;
  second.agent.close();
  await sleep(500);
  const destroyedB = events.filter(
    (event) => event.method === "Target.targetDestroyed" && event.params?.targetId === "page-b",
  );
  assert.equal(destroyedB.length, 1, "targetDestroyed must be sent exactly once");
  assert.ok(
    events.some(
      (event) =>
        event.method === "Target.detachedFromTarget" && event.params?.targetId === "page-b",
    ),
    "page sessions must detach before the target is destroyed",
  );
  targets = await send("Target.getTargets");
  assert.equal(
    targets.targetInfos.some((info) => info.targetId === "page-b"),
    false,
    "destroyed pages must disappear from Target.getTargets",
  );

  for (const agent of agents) agent.close();
});

test("a click that destroys its page resolves before the page socket timeout", async (t) => {
  const { port, version } = await startBridge(t, { PAGE_RECONNECT_GRACE_MS: "300" });
  const events = [];
  const responses = new Map();
  let requestId = 0;
  const cdp = new WebSocket(version.webSocketDebuggerUrl);
  t.after(() => cdp.close());
  cdp.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id) responses.set(message.id, message);
    else events.push(message);
  });
  await waitForOpen(cdp);
  const send = (method, params = {}, sessionId) => {
    requestId += 1;
    const id = requestId;
    cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const response = responses.get(id);
        if (!response) return;
        clearInterval(timer);
        if (response.error) reject(new Error(JSON.stringify(response.error)));
        else resolve(response.result);
      }, 5);
    });
  };

  await send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{}],
  });
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent`);
  t.after(() => agent.close());
  agent.on("open", () => {
    agent.send(
      JSON.stringify({
        type: "hello",
        browserId: "browser-1",
        pageId: "click-page",
        url: "https://example.com/",
        title: "Click page",
      }),
    );
  });
  // Intentionally do not answer requests: this simulates the document being
  // destroyed by the activation before the agent can reply.
  await waitForOpen(agent);
  await sleep(100);
  const attached = events.find(
    (event) =>
      event.method === "Target.attachedToTarget" &&
      event.params?.targetInfo?.targetId === "click-page",
  );
  assert.ok(attached);

  const started = Date.now();
  const clickResponse = send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x: 10, y: 10, button: "left", clickCount: 1 },
    attached.params.sessionId,
  );
  await sleep(30);
  agent.close();
  await clickResponse;
  assert.ok(Date.now() - started < 1000, "click must not wait for the 15s agent timeout");

  await sleep(400);
  assert.equal(
    events.filter(
      (event) =>
        event.method === "Target.targetDestroyed" && event.params?.targetId === "click-page",
    ).length,
    1,
  );
});
