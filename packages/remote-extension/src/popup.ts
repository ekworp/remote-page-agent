// @ts-nocheck

export {};

const translations = {
  en: {
    title: "Remote Page Agent",
    settings: "Settings",
    clear: "Clear history",
    history: "Command history",
    connected: "Connected tabs: ",
    empty: "No commands",
  },
  zh: {
    title: "Remote Page Agent",
    settings: "连接设置",
    clear: "清空历史",
    history: "命令执行历史",
    connected: "已连接页面：",
    empty: "暂无命令",
  },
};

function language(value) {
  if (value === "zh" || value === "en") return value;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function applyLanguage(value) {
  const strings = translations[language(value)];
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = strings[element.dataset.i18n];
  });
  return strings;
}

function render(state) {
  const strings = applyLanguage(state.language);
  const connections = state.connections.filter((connection) => connection.connected).length;
  document.querySelector("#connections").textContent = `${strings.connected}${connections}`;
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
    item.textContent = `${new Date(entry.timestamp).toLocaleTimeString()} ${entry.status === "success" ? "✓" : entry.status === "error" ? "✕" : "…"} ${entry.type}`;
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
