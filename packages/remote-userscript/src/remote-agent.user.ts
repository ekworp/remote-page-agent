// ==UserScript==
// @name         Remote Page Agent
// @namespace    remote-page-agent
// @version      __PACKAGE_VERSION__
// @description  Connect a page to the remote-page-agent CDP bridge.
// @icon         https://cdn.jsdelivr.net/gh/ekworp/remote-page-agent@main/assets/remote-page-agent.png
// @match        *://*/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// ==/UserScript==

declare function GM_registerMenuCommand(caption: string, onClick: () => void): void;
declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;
declare function GM_openInTab(
  url: string,
  options?: { active?: boolean; insert?: boolean; setParent?: boolean },
): unknown;

type AgentRequest = {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
  ok?: boolean;
  error?: { message?: string };
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
const bridgeTokenStorageKey = "remote-page-agent-bridge-token";
const languageStorageKey = "remote-page-agent-language";
const whitelistEnabledStorageKey = "remote-page-agent-whitelist-enabled";
const whitelistOriginsStorageKey = "remote-page-agent-whitelist-origins";
const temporaryGrantStorageKey = "remote-page-agent-temporary-grants";
const commandHistoryLimitStorageKey = "remote-page-agent-command-history-limit";
const defaultBridgeUrl = "ws://localhost:9222/agent";
const temporaryGrantTtlMs = 60_000;
const temporaryGrantIdleTtlMs = 5 * 60_000;
const temporaryGrantMaxLifetimeMs = 30 * 60_000;

type Language = "zh" | "en";
type LanguagePreference = Language | "auto";

const translations: Record<string, Record<Language, string>> = {
  configure: { zh: "连接设置", en: "Connection settings" },
  addCurrentOrigin: { zh: "将当前页面加入白名单", en: "Add current origin to whitelist" },
  removeCurrentOrigin: { zh: "将当前页面移出白名单", en: "Remove current origin from whitelist" },
  originAdded: { zh: "已将 {{origin}} 加入白名单", en: "Added {{origin}} to the whitelist" },
  originRemoved: { zh: "已将 {{origin}} 移出白名单", en: "Removed {{origin}} from the whitelist" },
  opacity: { zh: "透明度", en: "Opacity" },
  commandHistory: { zh: "命令执行历史", en: "Command history" },
  noCommandHistory: { zh: "暂无命令记录", en: "No commands yet" },
  historyLimit: { zh: "最多保留历史条数（1-200）", en: "Maximum history entries (1-200)" },
  settingsTitle: { zh: "Remote Page Agent 连接设置", en: "Remote Page Agent connection settings" },
  serverAddress: { zh: "服务器地址", en: "Server address" },
  connectionPassword: { zh: "连接密码", en: "Connection password" },
  language: { zh: "语言", en: "Language" },
  autoLanguage: { zh: "自动选择", en: "Automatic" },
  chinese: { zh: "中文", en: "Chinese" },
  english: { zh: "英文", en: "English" },
  whitelistEnabled: { zh: "仅自动连接白名单页面", en: "Auto-connect whitelist pages only" },
  whitelistOrigins: {
    zh: "白名单 origin（每行一个，例如 https://example.com）",
    en: "Allowed origins (one per line, e.g. https://example.com)",
  },
  cancel: { zh: "取消", en: "Cancel" },
  saveAndConnect: { zh: "保存并连接", en: "Save and connect" },
  invalidBridgeUrl: {
    zh: "服务器地址必须以 ws:// 或 wss:// 开头",
    en: "The server address must start with ws:// or wss://",
  },
  invalidOrigin: {
    zh: "白名单必须是 http:// 或 https:// origin，每行一个",
    en: "Allowed origins must be http:// or https:// origins, one per line",
  },
  configurationSaved: {
    zh: "连接设置已保存，正在连接",
    en: "Connection settings saved; connecting",
  },
  commandFailed: { zh: "命令失败：{{message}}", en: "Command failed: {{message}}" },
  notWhitelisted: {
    zh: "当前页面不在自动连接白名单中",
    en: "This page is not in the auto-connect whitelist",
  },
  connecting: { zh: "正在连接 Remote Page Agent", en: "Connecting to Remote Page Agent" },
  connected: { zh: "Remote Page Agent 已连接", en: "Remote Page Agent connected" },
  authenticationFailed: {
    zh: "Remote Page Agent 认证失败",
    en: "Remote Page Agent authentication failed",
  },
  disconnected: { zh: "Remote Page Agent 已断开", en: "Remote Page Agent disconnected" },
  reconnectStopped: {
    zh: "Remote Page Agent 已断开，自动重连已停止",
    en: "Remote Page Agent disconnected; automatic reconnect stopped",
  },
  reconnectAttempt: {
    zh: "将在 {{seconds}} 秒后重连（第 {{attempt}}/6 次）",
    en: "Reconnect attempt {{attempt}}/6 in {{seconds}}s",
  },
  connectionError: { zh: "Remote Page Agent 连接错误", en: "Remote Page Agent connection error" },
};

function getLanguagePreference(): LanguagePreference {
  const stored = GM_getValue<string>(languageStorageKey, "");
  if (stored === "zh" || stored === "en" || stored === "auto") return stored;
  return "auto";
}

function getLanguage(): Language {
  const preference = getLanguagePreference();
  if (preference === "zh" || preference === "en") return preference;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function translate(key: string, values: Record<string, string | number> = {}): string {
  let message = translations[key]?.[getLanguage()] ?? key;
  for (const [name, value] of Object.entries(values)) {
    message = message.split(`{{${name}}}`).join(String(value));
  }
  return message;
}
const browserIdStorageKey = "remote-page-agent-browser-id";
const pageIdStorageKey = "remote-page-agent-page-id";
const browserId = GM_getValue<string>(browserIdStorageKey, "") || crypto.randomUUID();
GM_setValue(browserIdStorageKey, browserId);
let pageId = "";
const namedPageId = window.name.startsWith("remote-page-agent:")
  ? window.name.slice("remote-page-agent:".length)
  : "";
const fragmentPageId = consumePageIdFragment();
try {
  pageId = fragmentPageId || namedPageId || sessionStorage.getItem(pageIdStorageKey) || "";
  if (!pageId) {
    pageId = crypto.randomUUID();
    sessionStorage.setItem(pageIdStorageKey, pageId);
  }
} catch {
  pageId = crypto.randomUUID();
}

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
let reconnectAttempt = 0;
let reconnectTimer: number | undefined;
let autoReconnectDisabled = false;
let notice: HTMLDivElement | undefined;
let statusIcon: SVGSVGElement | undefined;
let operationText: HTMLDivElement | undefined;
let noticeMenu: HTMLDivElement | undefined;
let historyList: HTMLUListElement | undefined;
let bridgeConfigDialog: HTMLDivElement | undefined;
const noticeOpacityKey = "remote-page-agent-notice-opacity";

type NoticeKind = "info" | "success" | "error";
type CommandStatus = "pending" | "success" | "error";
type CommandHistoryEntry = {
  id: string;
  type: string;
  timestamp: number;
  status: CommandStatus;
};

const commandHistory: CommandHistoryEntry[] = [];
const commandHistoryById = new Map<string, CommandHistoryEntry>();
const defaultCommandHistoryLimit = 30;

function commandHistoryLimit(): number {
  const value = GM_getValue<number>(commandHistoryLimitStorageKey, defaultCommandHistoryLimit);
  return Number.isInteger(value) ? Math.max(1, Math.min(200, value)) : defaultCommandHistoryLimit;
}

function trimCommandHistory(): void {
  while (commandHistory.length > commandHistoryLimit()) {
    const removed = commandHistory.shift();
    if (removed) commandHistoryById.delete(removed.id);
  }
}

function renderCommandHistory(): void {
  if (!historyList) return;
  historyList.replaceChildren();
  if (commandHistory.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = translate("noCommandHistory");
    empty.style.color = "#9ca3af";
    historyList.append(empty);
    return;
  }
  for (const entry of [...commandHistory].reverse()) {
    const item = document.createElement("li");
    const status = entry.status === "success" ? "✓" : entry.status === "error" ? "✕" : "…";
    const time = new Date(entry.timestamp).toLocaleTimeString();
    item.textContent = `${time}  ${status}  ${entry.type}`;
    item.style.color = entry.status === "error" ? "#fca5a5" : "#d1d5db";
    historyList.append(item);
  }
}

function recordCommand(id: string, type: string): void {
  const entry: CommandHistoryEntry = { id, type, timestamp: Date.now(), status: "pending" };
  commandHistory.push(entry);
  commandHistoryById.set(id, entry);
  trimCommandHistory();
  renderCommandHistory();
}

function completeCommand(id: string, status: Exclude<CommandStatus, "pending">): void {
  const entry = commandHistoryById.get(id);
  if (!entry) return;
  entry.status = status;
  renderCommandHistory();
}

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
      "background: rgba(17, 24, 39, var(--rpa-alpha))",
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
    const historyHeading = document.createElement("strong");
    historyHeading.textContent = translate("commandHistory");
    historyHeading.style.cssText = "display: block; margin-top: 12px;";
    menu.append(historyHeading);
    historyList = document.createElement("ul");
    historyList.style.cssText = [
      "max-height: 180px",
      "overflow: auto",
      "margin: 6px 0 0",
      "padding: 0",
      "list-style: none",
      "font: 11px/1.5 monospace",
    ].join(";");
    menu.append(historyList);
    renderCommandHistory();
    const label = document.createElement("label");
    label.style.cssText = "display: block; margin-top: 10px;";
    label.textContent = `${translate("opacity")} `;
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
    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.textContent = translate("configure");
    settingsButton.style.cssText = [
      "display: block",
      "width: 100%",
      "margin-top: 12px",
      "padding: 7px 10px",
      "border: 1px solid rgba(209, 213, 219, .7)",
      "border-radius: 6px",
      "background: rgba(255, 255, 255, .08)",
      "color: #f9fafb",
      "cursor: pointer",
      "font: inherit",
      "text-align: center",
    ].join(";");
    settingsButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (noticeMenu) noticeMenu.style.display = "none";
      configureBridge();
    });
    menu.append(settingsButton);
    const whitelistButton = document.createElement("button");
    whitelistButton.type = "button";
    whitelistButton.style.cssText = settingsButton.style.cssText;
    updateWhitelistButton(whitelistButton);
    whitelistButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleCurrentOriginWhitelist(whitelistButton);
    });
    menu.append(whitelistButton);
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

function getBridgeToken(): string {
  return GM_getValue<string>(bridgeTokenStorageKey, "").trim();
}

type TemporaryGrant = {
  origin: string;
  pageId: string;
  expiresAt: number;
  maxExpiresAt: number;
};

function whitelistEnabled(): boolean {
  return GM_getValue<boolean>(whitelistEnabledStorageKey, true);
}

function whitelistOrigins(): string[] {
  const storedOrigins = GM_getValue<unknown>(whitelistOriginsStorageKey, []);
  return (Array.isArray(storedOrigins) ? storedOrigins : []).filter(
    (origin): origin is string => typeof origin === "string" && origin.length > 0,
  );
}

function updateWhitelistButton(button: HTMLButtonElement): void {
  const origin = normalizeOrigin(location.origin);
  button.textContent =
    origin && whitelistOrigins().includes(origin)
      ? translate("removeCurrentOrigin")
      : translate("addCurrentOrigin");
}

function toggleCurrentOriginWhitelist(button: HTMLButtonElement): void {
  const origin = normalizeOrigin(location.origin);
  if (!origin) return;
  const origins = whitelistOrigins();
  if (origins.includes(origin)) {
    GM_setValue(
      whitelistOriginsStorageKey,
      origins.filter((candidate) => candidate !== origin),
    );
    updateWhitelistButton(button);
    showNotice(translate("originRemoved", { origin }), "success");
    return;
  }
  GM_setValue(whitelistOriginsStorageKey, [...origins, origin]);
  updateWhitelistButton(button);
  showNotice(translate("originAdded", { origin }), "success");
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function getTemporaryGrants(): TemporaryGrant[] {
  const now = Date.now();
  const storedValue = GM_getValue<unknown>(temporaryGrantStorageKey, []);
  const storedGrants = Array.isArray(storedValue) ? storedValue : [];
  const grants = storedGrants.filter(
    (grant) =>
      grant &&
      typeof grant.origin === "string" &&
      typeof grant.pageId === "string" &&
      Number.isFinite(grant.expiresAt) &&
      Number.isFinite(grant.maxExpiresAt) &&
      grant.expiresAt > now &&
      grant.maxExpiresAt > now,
  );
  if (grants.length !== storedGrants.length) {
    GM_setValue(temporaryGrantStorageKey, grants);
  }
  return grants;
}

function pageHasWhitelistAccess(origin = location.origin, currentPageId = pageId): boolean {
  if (!whitelistEnabled()) return true;
  if (whitelistOrigins().includes(origin)) return true;
  return getTemporaryGrants().some(
    (grant) => grant.origin === origin && (!grant.pageId || grant.pageId === currentPageId),
  );
}

function addTemporaryGrant(url: string, targetPageId: string): void {
  const origin = normalizeOrigin(url);
  if (!origin || whitelistOrigins().includes(origin)) return;
  const now = Date.now();
  const grants = getTemporaryGrants().filter((grant) => grant.pageId !== targetPageId);
  grants.push({
    origin,
    pageId: targetPageId,
    expiresAt: now + temporaryGrantTtlMs,
    maxExpiresAt: now + temporaryGrantMaxLifetimeMs,
  });
  GM_setValue(temporaryGrantStorageKey, grants);
}

function touchTemporaryGrant(): void {
  if (!whitelistEnabled()) return;
  const now = Date.now();
  const grants = getTemporaryGrants();
  let changed = false;
  for (const grant of grants) {
    if (grant.origin !== location.origin || grant.pageId !== pageId) continue;
    grant.expiresAt = Math.min(now + temporaryGrantIdleTtlMs, grant.maxExpiresAt);
    changed = true;
  }
  if (changed) GM_setValue(temporaryGrantStorageKey, grants);
}

function consumePageIdFragment(): string {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has("remote-page-agent-page")) return "";
  const value = params.get("remote-page-agent-page") ?? "";
  const originalHash = params.get("remote-page-agent-original-hash");
  try {
    const cleanUrl = `${location.pathname}${location.search}${originalHash ? `#${originalHash}` : ""}`;
    history.replaceState(history.state, document.title, cleanUrl);
  } catch {
    // The URL can be unavailable during very early document startup.
  }
  return value;
}

function urlWithPageId(url: string, targetPageId: string): string {
  const target = new URL(url, location.href);
  const originalHash = target.hash.slice(1);
  const marker = new URLSearchParams({
    "remote-page-agent-page": targetPageId,
    ...(originalHash ? { "remote-page-agent-original-hash": originalHash } : {}),
  });
  target.hash = marker.toString();
  return target.href;
}

function configureBridge(): void {
  if (bridgeConfigDialog?.isConnected) {
    bridgeConfigDialog.remove();
    bridgeConfigDialog = undefined;
    return;
  }

  const overlay = document.createElement("div");
  bridgeConfigDialog = overlay;
  overlay.setAttribute("data-remote-page-agent", "bridge-config");
  overlay.setAttribute("role", "presentation");
  overlay.style.cssText = [
    "position: fixed",
    "inset: 0",
    "z-index: 2147483647",
    "display: flex",
    "align-items: center",
    "justify-content: center",
    "padding: 20px",
    "background: rgba(0, 0, 0, .45)",
    "font: 14px/1.4 sans-serif",
  ].join(";");

  const panel = document.createElement("form");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "remote-page-agent-config-title");
  panel.style.cssText = [
    "width: min(420px, 100%)",
    "box-sizing: border-box",
    "padding: 20px",
    "border-radius: 12px",
    "background: #fff",
    "color: #111827",
    "box-shadow: 0 12px 40px rgba(0, 0, 0, .3)",
  ].join(";");

  const title = document.createElement("h2");
  title.id = "remote-page-agent-config-title";
  title.textContent = translate("settingsTitle");
  title.style.cssText = "margin: 0 0 16px; font-size: 18px;";
  panel.append(title);

  const field = (labelText: string, type: string, value: string): HTMLInputElement => {
    const label = document.createElement("label");
    label.style.cssText = "display: block; margin: 12px 0 0; font-weight: 600;";
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    input.setAttribute("autocomplete", type === "password" ? "new-password" : "url");
    input.style.cssText = [
      "display: block",
      "box-sizing: border-box",
      "width: 100%",
      "margin-top: 6px",
      "padding: 8px 10px",
      "border: 1px solid #d1d5db",
      "border-radius: 6px",
      "font: inherit",
    ].join(";");
    label.append(input);
    panel.append(label);
    return input;
  };

  const urlInput = field(translate("serverAddress"), "url", getBridgeUrl());
  const tokenInput = field(translate("connectionPassword"), "password", getBridgeToken());
  const historyLimitInput = field(
    translate("historyLimit"),
    "number",
    String(commandHistoryLimit()),
  );
  historyLimitInput.min = "1";
  historyLimitInput.max = "200";
  historyLimitInput.step = "1";

  const languageLabel = document.createElement("label");
  languageLabel.style.cssText = "display: block; margin-top: 12px; font-weight: 600;";
  languageLabel.textContent = translate("language");
  const languageSelect = document.createElement("select");
  languageSelect.style.cssText = [
    "display: block",
    "box-sizing: border-box",
    "width: 100%",
    "margin-top: 6px",
    "padding: 8px 10px",
    "border: 1px solid #d1d5db",
    "border-radius: 6px",
    "font: inherit",
  ].join(";");
  for (const [value, label] of [
    ["auto", translate("autoLanguage")],
    ["zh", translate("chinese")],
    ["en", translate("english")],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    languageSelect.append(option);
  }
  languageSelect.value = getLanguagePreference();
  languageLabel.append(languageSelect);
  panel.append(languageLabel);

  const whitelistLabel = document.createElement("label");
  whitelistLabel.style.cssText = "display: flex; gap: 8px; align-items: center; margin-top: 16px;";
  const whitelistInput = document.createElement("input");
  whitelistInput.type = "checkbox";
  whitelistInput.checked = whitelistEnabled();
  const whitelistText = document.createElement("span");
  whitelistText.textContent = translate("whitelistEnabled");
  whitelistLabel.append(whitelistInput, whitelistText);
  panel.append(whitelistLabel);

  const originsLabel = document.createElement("label");
  originsLabel.style.cssText = "display: block; margin-top: 10px; font-weight: 600;";
  originsLabel.textContent = translate("whitelistOrigins");
  const originsInput = document.createElement("textarea");
  originsInput.value = whitelistOrigins().join("\n");
  originsInput.rows = 4;
  originsInput.setAttribute("autocomplete", "off");
  originsInput.style.cssText = [
    "display: block",
    "box-sizing: border-box",
    "width: 100%",
    "margin-top: 6px",
    "padding: 8px 10px",
    "border: 1px solid #d1d5db",
    "border-radius: 6px",
    "font: inherit",
    "resize: vertical",
  ].join(";");
  originsLabel.append(originsInput);
  panel.append(originsLabel);

  const actions = document.createElement("div");
  actions.style.cssText = "display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px;";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = translate("cancel");
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = translate("saveAndConnect");
  for (const button of [cancel, save]) {
    button.style.cssText =
      "padding: 8px 12px; border: 0; border-radius: 6px; cursor: pointer; font: inherit;";
  }
  save.style.background = "#2563eb";
  save.style.color = "#fff";
  cancel.style.background = "#e5e7eb";
  actions.append(cancel, save);
  panel.append(actions);
  overlay.append(panel);

  const close = (): void => {
    overlay.remove();
    if (bridgeConfigDialog === overlay) bridgeConfigDialog = undefined;
  };
  cancel.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  panel.addEventListener("submit", (event) => {
    event.preventDefault();
    const url = urlInput.value.trim();
    if (!/^wss?:\/\//.test(url)) {
      urlInput.setCustomValidity(translate("invalidBridgeUrl"));
      urlInput.reportValidity();
      return;
    }
    urlInput.setCustomValidity("");
    const originLines = originsInput.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const origins = originLines.map(normalizeOrigin);
    if (origins.some((origin) => !origin)) {
      originsInput.setCustomValidity(translate("invalidOrigin"));
      originsInput.reportValidity();
      return;
    }
    originsInput.setCustomValidity("");
    const historyLimit = Number(historyLimitInput.value);
    if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 200) {
      historyLimitInput.setCustomValidity(translate("historyLimit"));
      historyLimitInput.reportValidity();
      return;
    }
    historyLimitInput.setCustomValidity("");
    GM_setValue(bridgeStorageKey, url);
    GM_setValue(bridgeTokenStorageKey, tokenInput.value.trim());
    GM_setValue(commandHistoryLimitStorageKey, historyLimit);
    trimCommandHistory();
    GM_setValue(
      languageStorageKey,
      languageSelect.value === "en" || languageSelect.value === "zh"
        ? languageSelect.value
        : "auto",
    );
    GM_setValue(whitelistEnabledStorageKey, whitelistInput.checked);
    GM_setValue(whitelistOriginsStorageKey, [...new Set(origins.filter(Boolean))]);
    close();
    autoReconnectDisabled = false;
    reconnectAttempt = 0;
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    socket?.close();
    socket = undefined;
    showNotice(translate("configurationSaved"), "info");
    connect();
  });
  document.body?.append(overlay);
  urlInput.focus();
}

GM_registerMenuCommand(translate("configure"), configureBridge);

function send(message: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function pageEvent(method: string, params: Record<string, unknown>): void {
  send({ type: "page_event", method, params, url: location.href, title: document.title });
}

function response(id: string, result: unknown, meta?: Record<string, unknown>): void {
  completeCommand(id, "success");
  touchTemporaryGrant();
  send({ id, ok: true, result, ...meta });
}

function failure(id: string, error: unknown): void {
  completeCommand(id, "error");
  const message = error instanceof Error ? error.message : String(error);
  showNotice(translate("commandFailed", { message }), "error");
  send({
    id,
    ok: false,
    error: {
      code: "COMMAND_FAILED",
      message,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isBodyTextExpression(code: string): boolean {
  const normalized = code.replace(/\s+/g, "");
  return /document\.body\?document\.body\.innerText:['"]NOBODY['"]/.test(normalized);
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
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (type === "hidden") return "none";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "search") return "searchbox";
    return "textbox";
  }
  if (tag === "img") return "image";
  if (tag === "p") return "paragraph";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "table") return "table";
  if (tag === "tr") return "row";
  if (tag === "th") return "columnheader";
  if (tag === "td") return "cell";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "li") return "listitem";
  return "generic";
}

function directTextContent(element: Element): string {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join(" ");
}

function accessibilityName(element: Element): string {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return normalizeAccessibilityName(ariaLabel);

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelledText = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (labelledText.trim()) return normalizeAccessibilityName(labelledText);
  }

  const alt = element.getAttribute("alt");
  if (alt) return normalizeAccessibilityName(alt);
  const title = element.getAttribute("title");
  if (title) return normalizeAccessibilityName(title);
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element.placeholder) return normalizeAccessibilityName(element.placeholder);
  }

  // Plain layout containers often contain the entire page's text. Treating
  // that text as their accessible name defeats tree compaction and produces
  // enormous duplicate names. Semantic elements still use rendered text.
  const role = accessibilityRole(element);
  const directText = normalizeAccessibilityName(directTextContent(element), 2000);
  const renderedText = element instanceof HTMLElement ? element.innerText : "";
  const text = normalizeAccessibilityName(renderedText || element.textContent || "");
  if (role === "generic" || role === "none") {
    if (directText) return directText;
    return text.length <= 80 ? text : "";
  }
  return text;
}

function normalizeAccessibilityName(value: string, maxLength = 500): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isHiddenFromAccessibilityTree(element: Element): boolean {
  if (element instanceof HTMLInputElement && element.type === "hidden") return true;
  if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") {
    return true;
  }
  const checkVisibility = (
    element as Element & {
      checkVisibility?: (options?: {
        checkOpacity?: boolean;
        checkVisibilityCSS?: boolean;
      }) => boolean;
    }
  ).checkVisibility;
  if (typeof checkVisibility === "function") {
    return !checkVisibility.call(element, {
      checkOpacity: false,
      checkVisibilityCSS: true,
    });
  }
  const style = getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden";
}

function isTransparentAccessibilityNode(role: string, name: string): boolean {
  return !name && (role === "generic" || role === "none");
}

function accessibilityTree(depth = 32): AccessibilityNode[] {
  pruneBackendNodeMap();
  const maxNodes = 3000;
  const nodes: AccessibilityNode[] = [];
  const nodesById = new Map<string, AccessibilityNode>();
  const visit = (element: Element, level: number): string[] => {
    if (isHiddenFromAccessibilityTree(element) || nodes.length >= maxNodes) return [];
    const backendNodeId = backendNodeIdFor(element);
    const nodeId = String(backendNodeId);
    const children: string[] = [];
    const name = accessibilityName(element);
    const role = accessibilityRole(element);
    if (level < depth) {
      for (const child of Array.from(element.children)) {
        if (nodes.length >= maxNodes) break;
        children.push(...visit(child, level + 1));
      }
    }
    // Layout-only wrappers are common on search pages. Flatten them while
    // retaining descendants, especially links and form controls.
    if (isTransparentAccessibilityNode(role, name)) return children;
    if (role === "generic" || role === "none") {
      const onlyChild = children.length === 1 ? nodesById.get(children[0]) : undefined;
      if (onlyChild?.name?.value === name) return children;
    }

    const node: AccessibilityNode = {
      nodeId,
      backendDOMNodeId: backendNodeId,
      backendNodeId,
      ignored: false,
      role: { type: "role", value: role },
      properties: [],
      childIds: children,
    };
    if (name) node.name = { type: "computedString", value: name };
    nodes.push(node);
    nodesById.set(nodeId, node);
    return [nodeId];
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
  if (document.body) root.childIds.push(...visit(document.body, 0));
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

type DomRectSnapshot = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
};

const clickableSelector = [
  "a[href]",
  "button",
  "[role=button]",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function rectSnapshot(rect: DOMRect): DomRectSnapshot {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
  };
}

function domRect(element: Element): DomRectSnapshot {
  return rectSnapshot(element.getBoundingClientRect());
}

function hasLayoutBox(element: Element): boolean {
  if (!element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isClickableElement(element: Element): boolean {
  return (
    element.matches(clickableSelector) ||
    (element instanceof HTMLElement && element.onclick !== null)
  );
}

function isEditableElement(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement &&
      (element.isContentEditable || element.getAttribute("contenteditable") === "true"))
  );
}

function resolveEditableTarget(element: Element): Element {
  if (isEditableElement(element)) return element;
  const descendant = element.querySelector(
    "input, textarea, select, [contenteditable='true'], [contenteditable='']",
  );
  return descendant ?? element;
}

/**
 * AX nodes often point at a generic wrapper. Prefer the nearest clickable
 * ancestor, otherwise the element itself, an actionable descendant, or the
 * nearest ancestor that at least has a layout box.
 */
function resolveClickTarget(element: Element): Element {
  // A textbox inside a label has a clickable ancestor, but clicking/filling the
  // label instead of the input would be wrong.
  if (isEditableElement(element) && hasLayoutBox(element)) return element;

  const ancestry: Element[] = [];
  let current: Element | null = element;
  while (current && ancestry.length < 12) {
    ancestry.push(current);
    current = current.parentElement;
  }

  for (const candidate of ancestry.slice(1)) {
    if (isClickableElement(candidate) && hasLayoutBox(candidate)) return candidate;
  }
  if (hasLayoutBox(element)) return element;

  const descendant = element.querySelector(clickableSelector);
  if (descendant && hasLayoutBox(descendant)) return descendant;

  for (const candidate of ancestry) {
    if (hasLayoutBox(candidate)) return candidate;
  }
  return element;
}

function describeElement(element: Element): Record<string, unknown> {
  return {
    backendNodeId: backendNodeIdFor(element),
    tagName: element.tagName.toLowerCase(),
    className: typeof element.className === "string" ? element.className.slice(0, 120) : undefined,
  };
}

function immediateScrollIntoView(element: Element): void {
  const changed: Array<{ element: HTMLElement; previous: string }> = [];
  let current: Element | null = element;
  while (current) {
    if (current instanceof HTMLElement) {
      const style = getComputedStyle(current);
      const scrollable =
        /(auto|scroll)/.test(style.overflowY) || /(auto|scroll)/.test(style.overflowX);
      if (scrollable) {
        changed.push({ element: current, previous: current.style.scrollBehavior });
        current.style.scrollBehavior = "auto";
      }
    }
    current = current.parentElement;
  }
  element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  for (const { element: scrollable, previous } of changed) {
    scrollable.style.scrollBehavior = previous;
  }
}

function scheduleElementClick(element: Element, eventInit: MouseEventInit = {}): void {
  window.setTimeout(() => {
    if (!element.isConnected) return;
    if (element instanceof HTMLElement) {
      element.click();
      return;
    }
    element.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ...eventInit,
        buttons: 0,
      }),
    );
  }, 0);
}

function createValueEvent(type: "beforeinput" | "input", data: string, inputType: string): Event {
  try {
    return new InputEvent(type, {
      bubbles: true,
      cancelable: type === "beforeinput",
      data,
      inputType,
    });
  } catch {
    return new Event(type, { bubbles: true, cancelable: type === "beforeinput" });
  }
}

function dispatchBeforeInput(element: Element, value: string, inputType = "insertText"): boolean {
  return element.dispatchEvent(createValueEvent("beforeinput", value, inputType));
}

function dispatchInputAndChange(element: Element, value: string, inputType = "insertText"): void {
  element.dispatchEvent(createValueEvent("input", value, inputType));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function inputKind(element: Element): string {
  if (element instanceof HTMLSelectElement) return "select";
  if (element instanceof HTMLTextAreaElement) return "typeable-input";
  if (element instanceof HTMLInputElement) {
    switch (element.type) {
      case "checkbox":
      case "radio":
        return "checkable-input";
      case "text":
      case "url":
      case "tel":
      case "search":
      case "password":
      case "number":
      case "email":
        return "typeable-input";
      default:
        return "other-input";
    }
  }
  switch (element.getAttribute("role")) {
    case "checkbox":
    case "radio":
    case "switch":
      return "checkable-input";
  }
  if (element instanceof HTMLElement && element.isContentEditable) return "contenteditable";
  return "unknown";
}

function currentEditableValue(element: Element): string {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return element.value;
  }
  if (element instanceof HTMLElement && element.isContentEditable) return element.innerText;
  return "";
}

function selectedOptionValues(element: HTMLSelectElement, values: string[]): string[] {
  const wanted = new Set(values);
  const options = Array.from(element.options);
  for (const option of options) {
    if (!element.multiple) option.selected = false;
  }
  const selected: string[] = [];
  for (const option of options) {
    const matches = wanted.has(option.value) || wanted.has((option.textContent ?? "").trim());
    if (element.multiple) {
      option.selected = matches;
    } else if (matches && selected.length === 0) {
      option.selected = true;
    }
    if (option.selected) selected.push(option.value);
  }
  return selected;
}

function fillElement(
  element: Element,
  value: string | boolean | string[],
): Record<string, unknown> {
  if (element instanceof HTMLSelectElement) {
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    const eventValue = values.join(",");
    if (!dispatchBeforeInput(element, eventValue)) {
      return { cancelled: true, value: element.value, ...describeElement(element) };
    }
    const selected = selectedOptionValues(element, values);
    dispatchInputAndChange(element, eventValue);
    return { value: element.value, selected, ...describeElement(element) };
  }
  if (element instanceof HTMLInputElement) {
    element.focus();
    if (element.type === "checkbox" || element.type === "radio") {
      if (!dispatchBeforeInput(element, String(value))) {
        return { cancelled: true, checked: element.checked, ...describeElement(element) };
      }
      element.checked = value === true || value === "true";
      dispatchInputAndChange(element, String(element.checked));
      return { value: element.value, checked: element.checked, ...describeElement(element) };
    }
    if (typeof value !== "string") throw new Error("Input value must be a string");
    if (element.value === value) {
      return { unchanged: true, value: element.value, ...describeElement(element) };
    }
    if (!dispatchBeforeInput(element, value)) {
      return { cancelled: true, value: element.value, ...describeElement(element) };
    }
    element.value = value;
    try {
      element.setSelectionRange(value.length, value.length);
    } catch {
      // Some input types do not support selection ranges.
    }
    dispatchInputAndChange(element, value);
    return { value: element.value, ...describeElement(element) };
  }
  if (element instanceof HTMLTextAreaElement) {
    if (typeof value !== "string") throw new Error("Textarea value must be a string");
    element.focus();
    if (element.value === value) {
      return { unchanged: true, value: element.value, ...describeElement(element) };
    }
    if (!dispatchBeforeInput(element, value)) {
      return { cancelled: true, value: element.value, ...describeElement(element) };
    }
    element.value = value;
    element.setSelectionRange(value.length, value.length);
    dispatchInputAndChange(element, value);
    return { value: element.value, ...describeElement(element) };
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    if (typeof value !== "string") throw new Error("Contenteditable value must be a string");
    element.focus();
    if (element.innerText === value) {
      return { unchanged: true, value: element.innerText, ...describeElement(element) };
    }
    if (!dispatchBeforeInput(element, value)) {
      return { cancelled: true, value: element.innerText, ...describeElement(element) };
    }
    element.innerText = value;
    dispatchInputAndChange(element, value);
    return { value: element.innerText, ...describeElement(element) };
  }
  throw new Error("Element does not support a value");
}

function isCheckableElement(element: Element): boolean {
  if (element instanceof HTMLInputElement) {
    return element.type === "checkbox" || element.type === "radio";
  }
  const role = element.getAttribute("role");
  return role === "checkbox" || role === "radio" || role === "switch";
}

function currentCheckedState(element: Element): boolean | "mixed" {
  if (element instanceof HTMLInputElement) {
    if (element.indeterminate) return "mixed";
    return element.checked;
  }
  const aria = element.getAttribute("aria-checked");
  if (aria === "mixed") return "mixed";
  return aria === "true";
}

function insertText(element: Element, text: string): Record<string, unknown> {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.focus();
    if (!dispatchBeforeInput(element, text)) {
      return { cancelled: true, value: element.value, ...describeElement(element) };
    }
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    element.value = `${element.value.slice(0, start)}${text}${element.value.slice(end)}`;
    try {
      const caret = start + text.length;
      element.setSelectionRange(caret, caret);
    } catch {
      // Some input types do not support selection ranges.
    }
    dispatchInputAndChange(element, text);
    return { value: element.value, ...describeElement(element) };
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    element.focus();
    if (!dispatchBeforeInput(element, text)) {
      return { cancelled: true, value: element.innerText, ...describeElement(element) };
    }
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && element.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      element.textContent = `${element.textContent ?? ""}${text}`;
    }
    dispatchInputAndChange(element, text);
    return { value: element.innerText, ...describeElement(element) };
  }
  throw new Error("Active element does not support text insertion");
}

function domOperation(
  operation: string,
  backendNodeId: number,
  payload: Record<string, unknown>,
): unknown {
  if (operation === "document_size") {
    return {
      documentWidth: document.documentElement?.clientWidth ?? window.innerWidth,
      documentHeight: document.documentElement?.clientHeight ?? window.innerHeight,
    };
  }
  const element = elementByBackendNodeId(backendNodeId);
  if (!element) throw new Error(`DOM node not found: ${backendNodeId}`);
  const clickTarget = resolveClickTarget(element);
  const editableTarget = resolveEditableTarget(element);
  switch (operation) {
    case "click": {
      const anchor = clickTarget.closest("a[href]");
      scheduleElementClick(clickTarget);
      return {
        clicked: true,
        scheduledClick: true,
        navigationHint:
          anchor instanceof HTMLAnchorElement
            ? anchor.target === "_blank"
              ? "popup"
              : "navigation"
            : undefined,
        ...describeElement(clickTarget),
      };
    }
    case "rect":
      return domRect(clickTarget);
    case "client_rects":
      return Array.from(clickTarget.getClientRects(), rectSnapshot);
    case "stable_rects":
      return new Promise((resolve) => {
        const finish = (): void => {
          // Report the same final rect twice. Puppeteer only needs to know
          // that the element has a stable box; measuring twice while a
          // carousel or lazy image is animating can otherwise never settle.
          const rect = domRect(clickTarget);
          resolve([rect, rect]);
        };
        requestAnimationFrame(() => requestAnimationFrame(finish));
        window.setTimeout(finish, 250);
      });
    case "is_intersecting": {
      const rect = clickTarget.getBoundingClientRect();
      // Let Puppeteer's scrollIntoViewIfNeeded path handle viewport and
      // nested-scroller visibility. Requiring intersection here makes
      // off-screen media cards fail actionability before they can be scrolled.
      return clickTarget.isConnected && rect.width > 0 && rect.height > 0;
    }
    case "assert_connected":
      if (!element.isConnected) return "Node is detached from document";
      if (element.nodeType !== Node.ELEMENT_NODE) return "Node is not of type HTMLElement";
      return null;
    case "is_svg":
      return clickTarget instanceof SVGElement;
    case "scroll_into_view":
      immediateScrollIntoView(clickTarget);
      return { scrolled: true, rect: domRect(clickTarget), ...describeElement(clickTarget) };
    case "focus":
      if (editableTarget instanceof HTMLElement) editableTarget.focus();
      return { focused: true, ...describeElement(editableTarget) };
    case "get_input_kind":
      return inputKind(editableTarget);
    case "get_enabled": {
      const ariaDisabled = editableTarget.getAttribute("aria-disabled") === "true";
      const disabled =
        editableTarget instanceof HTMLInputElement ||
        editableTarget instanceof HTMLButtonElement ||
        editableTarget instanceof HTMLTextAreaElement ||
        editableTarget instanceof HTMLSelectElement ||
        editableTarget instanceof HTMLOptionElement
          ? editableTarget.disabled
          : false;
      return !disabled && !ariaDisabled;
    }
    case "get_value":
      return currentEditableValue(editableTarget);
    case "is_checkable":
      return isCheckableElement(editableTarget);
    case "get_checked":
      return currentCheckedState(editableTarget);
    case "fill":
    case "set_value": {
      const values = payload.values;
      const value = Array.isArray(values) ? values.map(String) : payload.value;
      if (typeof value !== "string" && typeof value !== "boolean" && !Array.isArray(value)) {
        throw new Error("value is required");
      }
      return fillElement(editableTarget, value);
    }
    case "select_option": {
      if (!(editableTarget instanceof HTMLSelectElement)) {
        throw new Error("Element is not a select");
      }
      const values = Array.isArray(payload.values)
        ? payload.values.map(String)
        : [String(payload.value ?? "")];
      return fillElement(editableTarget, values);
    }
    case "inspect_element": {
      const rect = editableTarget.getBoundingClientRect();
      return {
        ...describeElement(editableTarget),
        inputType: editableTarget instanceof HTMLInputElement ? editableTarget.type : undefined,
        placeholder:
          editableTarget instanceof HTMLInputElement ||
          editableTarget instanceof HTMLTextAreaElement
            ? editableTarget.placeholder
            : undefined,
        disabled:
          editableTarget instanceof HTMLInputElement ||
          editableTarget instanceof HTMLTextAreaElement ||
          editableTarget instanceof HTMLSelectElement
            ? editableTarget.disabled
            : undefined,
        readOnly:
          editableTarget instanceof HTMLInputElement ||
          editableTarget instanceof HTMLTextAreaElement
            ? editableTarget.readOnly
            : undefined,
        contentEditable:
          editableTarget instanceof HTMLElement ? editableTarget.isContentEditable : false,
        connected: editableTarget.isConnected,
        rect: rectSnapshot(rect),
        clientRectCount: editableTarget.getClientRects().length,
        editable: isEditableElement(editableTarget),
      };
    }
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

function elementAtPoint(x: number, y: number): Element | null {
  // The agent status badge is fixed on top of the page. Never let it swallow a
  // remote click.
  const stack = document.elementsFromPoint(x, y);
  const hit = stack.find((element) => !element.closest("[data-remote-page-agent]"));
  return hit ?? document.elementFromPoint(x, y);
}

function dispatchInput(payload: Record<string, unknown>): Record<string, unknown> {
  const selectorValue = typeof payload.selector === "string" ? payload.selector : "";
  const x = Number(payload.x ?? 0);
  const y = Number(payload.y ?? 0);
  const type = typeof payload.type === "string" ? payload.type : "click";
  const hit =
    (selectorValue ? document.querySelector(selectorValue) : null) ??
    (type.startsWith("key") || type === "char" ? document.activeElement : elementAtPoint(x, y));
  const element = hit ?? document.body;
  if (!(element instanceof HTMLElement)) throw new Error("input target not found");
  const clickTarget = resolveClickTarget(element);
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
  const result = {
    type,
    x,
    y,
    button,
    hit: describeElement(element),
    target: describeElement(clickTarget),
    usedClick: false,
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
    if (type === "keyDown" && payload.key === "Enter") {
      const form = element.closest("form");
      if (form instanceof HTMLFormElement) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
      } else if (element instanceof HTMLInputElement) {
        const submit = document.querySelector<HTMLButtonElement>(
          "button[type=submit], input[type=submit]",
        );
        submit?.click();
      }
    }
    return result;
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
    return result;
  }
  if (type === "mousePressed") {
    clickTarget.dispatchEvent(new MouseEvent("mousedown", mouseInit));
    return result;
  }
  if (type === "mouseReleased") {
    clickTarget.dispatchEvent(new MouseEvent("mouseup", mouseInit));
    const anchor = clickTarget.closest("a[href]");
    const navigationHint =
      anchor instanceof HTMLAnchorElement
        ? anchor.target === "_blank"
          ? "popup"
          : "navigation"
        : undefined;
    // Send the CDP response before activating the element. A navigation or
    // target="_blank" popup can destroy this document immediately; doing
    // click() synchronously would race the WebSocket response and leave the
    // MCP tool waiting for a dead page.
    scheduleElementClick(clickTarget, {
      ...mouseInit,
      detail: Number(payload.clickCount ?? 1),
    });
    return { ...result, scheduledClick: true, navigationHint };
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
  return result;
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
      scheduleElementClick(selector(payload));
      response(request.id, { clicked: true, scheduledClick: true });
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
      scheduleElementClick(target);
      response(request.id, { clicked: true, scheduledClick: true, text });
      return;
    }
    case "input": {
      const element = resolveEditableTarget(selector(payload));
      const value = payload.value;
      if (typeof value !== "string" && typeof value !== "boolean") {
        throw new Error("value is required");
      }
      if (!isEditableElement(element)) {
        throw new Error("Element is not editable");
      }
      response(request.id, fillElement(element, value));
      return;
    }
    case "insert_text": {
      const value = payload.text;
      if (typeof value !== "string") throw new Error("text is required");
      const element = document.activeElement;
      if (!element || !isEditableElement(element)) {
        throw new Error("Active element is not editable");
      }
      response(request.id, insertText(element, value));
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
      response(request.id, { url: payload.url });
      window.setTimeout(() => {
        location.href = payload.url as string;
      }, 0);
      return;
    }
    case "open_page": {
      if (typeof payload.url !== "string" || typeof payload.pageId !== "string") {
        throw new Error("url and pageId are required");
      }
      addTemporaryGrant(payload.url, payload.pageId);
      const targetUrl = urlWithPageId(payload.url, payload.pageId);
      if (typeof GM_openInTab === "function") {
        GM_openInTab(targetUrl, { active: true, insert: true, setParent: true });
      } else {
        const popup = window.open(targetUrl, `remote-page-agent:${payload.pageId}`);
        if (!popup) throw new Error("The browser blocked opening a new page");
      }
      response(request.id, { opened: true, pageId: payload.pageId });
      return;
    }
    case "history_back":
      response(request.id, { ok: true });
      window.setTimeout(() => history.back(), 0);
      return;
    case "reload":
      response(request.id, { ok: true });
      window.setTimeout(() => location.reload(), 0);
      return;
    case "stop_loading":
      window.stop();
      response(request.id, { ok: true });
      return;
    case "dispatch_input": {
      const result = dispatchInput(payload);
      response(request.id, result);
      return;
    }
    case "click_backend_node": {
      const backendNodeId = Number(payload.backendNodeId);
      const element = elementByBackendNodeId(backendNodeId);
      if (!element) throw new Error("DOM node not found");
      const target = resolveClickTarget(element);
      scheduleElementClick(target);
      response(request.id, {
        clicked: true,
        scheduledClick: true,
        backendNodeId,
        ...describeElement(target),
      });
      return;
    }
    case "get_dom_rect": {
      const backendNodeId = Number(payload.backendNodeId);
      const element = elementByBackendNodeId(backendNodeId);
      if (!element) throw new Error("DOM node not found");
      response(request.id, domRect(resolveClickTarget(element)));
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
      if (isBodyTextExpression(code)) {
        const bodyText = document.body?.innerText ?? "NO BODY";
        response(
          request.id,
          code.includes("JSON.stringify") ? JSON.stringify(bodyText) : bodyText,
          {
            resultType: "string",
          },
        );
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
  if (!bridgeUrl || autoReconnectDisabled || !pageHasWhitelistAccess()) {
    if (whitelistEnabled() && !pageHasWhitelistAccess()) {
      showNotice(translate("notWhitelisted"), "info");
    }
    return;
  }
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  showNotice(translate("connecting"), "info");
  const currentSocket = new WebSocket(bridgeUrl);
  socket = currentSocket;
  currentSocket.addEventListener("open", () => {
    showNotice(translate("connected"), "success");
    send({
      type: "hello",
      browserId,
      pageId,
      token: getBridgeToken(),
      url: location.href,
      title: document.title,
    });
  });
  currentSocket.addEventListener("message", (event) => {
    try {
      const parsed: unknown = JSON.parse(String(event.data));
      if (!isRecord(parsed)) throw new Error("Incoming message must be an object");
      const message = parsed as AgentRequest & { pageId?: string };
      if (message.type === "hello_ack" && message.ok === false) {
        autoReconnectDisabled = true;
        showNotice(translate("authenticationFailed"), "error");
        currentSocket.close(1008, "Authentication failed");
        return;
      }
      if (message.type === "hello_ack" && message.ok === true) {
        reconnectAttempt = 0;
        showNotice(translate("connected"), "success");
      }
      if (message.type === "hello_ack" && typeof message.pageId === "string") {
        pageId = message.pageId;
        try {
          sessionStorage.setItem(pageIdStorageKey, pageId);
        } catch {
          // Storage can be unavailable in private or sandboxed contexts.
        }
        return;
      }
      if (typeof message.id !== "string" || !message.id) {
        throw new Error("Incoming command requires a non-empty id");
      }
      if (typeof message.type !== "string" || !message.type) {
        failure(message.id, new Error("Incoming command requires a non-empty type"));
        return;
      }
      if (message.payload !== undefined && !isRecord(message.payload)) {
        failure(message.id, new Error("Command payload must be an object"));
        return;
      }
      recordCommand(message.id, message.type);
      void execute(message).catch((error) => failure(message.id, error));
    } catch (error) {
      console.error("Remote Page Agent message error", error);
    }
  });
  currentSocket.addEventListener("close", () => {
    if (socket === currentSocket) showNotice(translate("disconnected"), "error");
    if (socket !== currentSocket || !getBridgeUrl() || autoReconnectDisabled) return;
    reconnectAttempt += 1;
    if (reconnectAttempt > 6) {
      autoReconnectDisabled = true;
      showNotice(translate("reconnectStopped"), "error");
      return;
    }
    const delay = reconnectAttempt <= 3 ? 5000 : 10000;
    showNotice(
      translate("reconnectAttempt", {
        attempt: reconnectAttempt,
        seconds: delay / 1000,
      }),
      "info",
    );
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  });
  currentSocket.addEventListener("error", () => {
    if (socket === currentSocket) showNotice(translate("connectionError"), "error");
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
function announceNavigation(): void {
  pageEvent("Page.frameNavigated", {
    frame: {
      id: pageId,
      url: location.href,
      securityOrigin: location.origin,
      mimeType: "text/html",
    },
  });
  pageEvent("Page.navigatedWithinDocument", {
    frameId: pageId,
    url: location.href,
  });
  pageEvent("Page.lifecycleEvent", {
    frameId: pageId,
    loaderId: pageId,
    name: "load",
    timestamp: Date.now() / 1000,
  });
}

function scheduleNavigationAnnouncement(): void {
  window.setTimeout(announceNavigation, 0);
}

window.addEventListener("popstate", scheduleNavigationAnnouncement);
window.addEventListener("hashchange", scheduleNavigationAnnouncement);

const originalPushState = history.pushState;
history.pushState = function (
  this: History,
  data: unknown,
  unused: string,
  url?: string | URL | null,
): void {
  originalPushState.call(this, data, unused, url);
  scheduleNavigationAnnouncement();
};

const originalReplaceState = history.replaceState;
history.replaceState = function (
  this: History,
  data: unknown,
  unused: string,
  url?: string | URL | null,
): void {
  originalReplaceState.call(this, data, unused, url);
  scheduleNavigationAnnouncement();
};

for (const method of ["log", "warn", "error"] as const) {
  const original = console[method];
  console[method] = (...args: unknown[]) => {
    original(...args);
    send({ type: "console", method, args: args.map(String), url: location.href });
  };
}

connect();
