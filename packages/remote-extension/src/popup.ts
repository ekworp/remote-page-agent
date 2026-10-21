// @ts-nocheck

export {};

const translations = {
  en: {
    title: "Remote Page Agent",
    subtitle: "Remote browser control",
    settings: "Settings",
    clear: "Clear history",
    history: "Command history",
    connectionStatus: "Connection status",
    connected: "Connected tabs: ",
    empty: "No commands",
    whitelistAction: "Allow this page",
    whitelistHint: "Add the active page to the whitelist.",
    addCurrentOrigin: "Add page",
    originAdded: "Page origin added",
    alreadyAdded: "Page origin is already allowed",
    noPage: "No web page is active",
  },
  zh: {
    title: "网页操盘手",
    subtitle: "远程控制浏览器页面",
    settings: "连接设置",
    clear: "清空历史",
    history: "命令执行历史",
    connectionStatus: "连接状态",
    connected: "已连接页面：",
    empty: "暂无命令",
    whitelistAction: "允许当前页面",
    whitelistHint: "将当前页面加入白名单。",
    addCurrentOrigin: "加入页面",
    originAdded: "已加入页面来源",
    alreadyAdded: "该页面来源已经允许",
    noPage: "当前没有活动网页",
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
document
  .querySelector("#options")
  .addEventListener("click", () => chrome.runtime.openOptionsPage());
document.querySelector("#clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clear_history" });
  const state = await chrome.runtime.sendMessage({ type: "popup_state" });
  render(state);
});

function showStatus(text) {
  const status = document.querySelector("#status");
  status.textContent = text;
  setTimeout(() => {
    status.textContent = "";
  }, 1800);
}

document.querySelector("#addCurrentOrigin").addEventListener("click", async () => {
  const settings = await chrome.storage.local.get({ language: "auto" });
  const strings = translations[language(settings.language)];
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let origin = "";
  try {
    const url = new URL(tab?.url || "");
    if (/^https?:$/.test(url.protocol)) origin = url.origin;
  } catch {
    // The active tab may be a browser or extension page.
  }
  if (!origin) {
    showStatus(strings.noPage);
    return;
  }
  const values = await chrome.storage.local.get({ whitelistOrigins: [] });
  const origins = Array.isArray(values.whitelistOrigins) ? values.whitelistOrigins : [];
  if (origins.includes(origin)) {
    showStatus(strings.alreadyAdded);
    return;
  }
  await chrome.storage.local.set({ whitelistOrigins: [...origins, origin] });
  showStatus(strings.originAdded);
});
