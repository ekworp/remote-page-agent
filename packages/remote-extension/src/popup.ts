// @ts-nocheck

export {};

const translations = {
  en: {
    title: "Remote DevTools",
    subtitle: "Remote browser control",
    settings: "Settings",
    version: "Version",
    clear: "Clear history",
    history: "Command history",
    connectionStatus: "Connection status",
    connected: "Connected tabs: ",
    empty: "No commands",
    addCurrentOrigin: "Add current page",
    originAdded: "Page origin added",
    alreadyAdded: "Page origin is already allowed",
    noPage: "Current page unavailable",
    reconnect: "Reconnect current page",
    reconnecting: "Reconnecting…",
    reconnected: "Reconnect requested",
  },
  zh: {
    title: "Remote DevTools",
    subtitle: "远程控制浏览器页面",
    settings: "连接设置",
    version: "版本",
    clear: "清空历史",
    history: "命令执行历史",
    connectionStatus: "连接状态",
    connected: "已连接页面：",
    empty: "暂无命令",
    addCurrentOrigin: "加入当前页面",
    originAdded: "已加入页面来源",
    alreadyAdded: "当前页面已允许",
    noPage: "当前页面不可用",
    reconnect: "重新连接当前页面",
    reconnecting: "正在重新连接…",
    reconnected: "已请求重新连接",
  },
};

function language(value) {
  if (value === "zh" || value === "en") return value;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function applyLanguage(value) {
  const strings = translations[language(value)];
  document.title = strings.title;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = strings[element.dataset.i18n];
  });
  document.querySelectorAll("[data-i18n-label]").forEach((element) => {
    const label = strings[element.dataset.i18nLabel];
    element.setAttribute("aria-label", label);
    element.setAttribute("title", label);
  });
  return strings;
}

function render(state) {
  const strings = applyLanguage(state.language);
  const connections = state.connections.filter((connection) => connection.connected).length;
  const connectionLabel = document.querySelector("#connections");
  const statusDot = document.querySelector("#statusDot");
  connectionLabel.textContent = `${strings.connected}${connections}`;
  connectionLabel.className = connections > 0 ? "online" : "offline";
  statusDot.className = connections > 0 ? "dot" : "dot offline";
  const history = document.querySelector("#history");
  history.replaceChildren();
  if (!state.history.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = strings.empty;
    history.append(empty);
    return;
  }
  for (const entry of state.history) {
    const item = document.createElement("li");
    item.className = entry.status;
    const command = document.createElement("span");
    command.className = "command";
    command.textContent = `${entry.status === "success" ? "✓" : entry.status === "error" ? "✕" : "…"} ${entry.type}`;
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = new Date(entry.timestamp).toLocaleTimeString();
    item.append(command, time);
    history.append(item);
  }
}

chrome.runtime.sendMessage({ type: "popup_state" }).then(render);
document.querySelector("#version").textContent = chrome.runtime.getManifest().version;
document.querySelector("#reconnect").addEventListener("click", async () => {
  const settings = await chrome.storage.local.get({ language: "auto" });
  const strings = translations[language(settings.language)];
  const button = document.querySelector("#reconnect");
  button.disabled = true;
  button.textContent = strings.reconnecting;
  const result = await chrome.runtime.sendMessage({ type: "reconnect_active" });
  button.textContent = result?.ok ? strings.reconnected : strings.reconnect;
  showStatus(result?.ok ? strings.reconnected : result?.error || strings.reconnect);
  window.setTimeout(() => {
    button.disabled = false;
    button.textContent = strings.reconnect;
  }, 1500);
});
document
  .querySelector("#options")
  .addEventListener("click", () => chrome.runtime.openOptionsPage());
document.querySelector("#clear").addEventListener("click", async () => {
  const state = await chrome.runtime.sendMessage({ type: "popup_state" });
  await chrome.runtime.sendMessage({ type: "clear_history", pageId: state.pageId });
  const updatedState = await chrome.runtime.sendMessage({ type: "popup_state" });
  render(updatedState);
});

function showStatus(text) {
  const status = document.querySelector("#status");
  status.textContent = text;
  setTimeout(() => {
    status.textContent = "";
  }, 1800);
}

function activeOrigin(tab) {
  try {
    const url = new URL(tab?.url || "");
    return /^https?:$/.test(url.protocol) ? url.origin : "";
  } catch {
    return "";
  }
}

async function updateWhitelistButton() {
  const settings = await chrome.storage.local.get({ language: "auto" });
  const strings = translations[language(settings.language)];
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const origin = activeOrigin(tab);
  const button = document.querySelector("#addCurrentOrigin");
  const values = await chrome.storage.local.get({ whitelistOrigins: [] });
  const origins = Array.isArray(values.whitelistOrigins) ? values.whitelistOrigins : [];
  const allowed = Boolean(origin && origins.includes(origin));
  button.disabled = !origin || allowed;
  button.classList.toggle("allowed", allowed);
  button.classList.toggle("unavailable", !origin);
  button.textContent = !origin
    ? strings.noPage
    : allowed
      ? strings.alreadyAdded
      : strings.addCurrentOrigin;
  return { button, origin, origins, strings };
}

document.querySelector("#addCurrentOrigin").addEventListener("click", async () => {
  const { button, origin, origins, strings } = await updateWhitelistButton();
  if (!origin) {
    showStatus(strings.noPage);
    return;
  }
  if (origins.includes(origin)) {
    showStatus(strings.alreadyAdded);
    return;
  }
  await chrome.storage.local.set({ whitelistOrigins: [...origins, origin] });
  button.disabled = true;
  button.classList.add("allowed");
  button.textContent = strings.alreadyAdded;
  showStatus(strings.originAdded);
});

updateWhitelistButton();
