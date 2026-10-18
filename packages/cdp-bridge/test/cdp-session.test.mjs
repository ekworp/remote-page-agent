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

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

test("CDP sessions receive execution contexts and evaluate functions", async (t) => {
  const port = await freePort();
  const bridge = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  t.after(() => bridge.kill("SIGTERM"));

  const version = await waitForBridge(port);

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
  const port = await freePort();
  const bridge = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  t.after(() => bridge.kill("SIGTERM"));

  const version = await waitForBridge(port);
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
  assert.ok(clicks.some((item) => item.type === "mouseReleased"));

  const navigated = events.find(
    (event) => event.method === "Page.frameNavigated" && event.sessionId === sessionId,
  );
  assert.ok(navigated, "agent page events should be forwarded to the page session");

  const targets = await send("Target.getTargets");
  assert.equal(targets.targetInfos[0].url, "https://example.com/after-click");
});
