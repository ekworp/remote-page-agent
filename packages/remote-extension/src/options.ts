// @ts-nocheck

export {};

const defaults = {
  bridgeUrl: "ws://localhost:9222/agent",
  bridgeToken: "",
  whitelistEnabled: false,
  whitelistOrigins: [],
  language: "auto",
  commandHistoryLimit: 50,
};
const translations = {
  en: {
    title: "Remote Page Agent",
    bridgeUrl: "Bridge WebSocket URL",
    token: "Connection token",
    whitelistEnabled: "Only connect on allowed origins",
    whitelistOrigins: "Allowed origins, one per line",
    language: "Interface language",
    historyLimit: "Maximum history entries",
    save: "Save",
    saved: "Saved",
  },
  zh: {
    title: "Remote Page Agent",
    bridgeUrl: "Bridge WebSocket 地址",
    token: "连接密码",
    whitelistEnabled: "只连接白名单中的页面",
    whitelistOrigins: "允许的来源，每行一个",
    language: "界面语言",
    historyLimit: "最多保留历史条数",
    save: "保存",
    saved: "已保存",
  },
};
const form = document.querySelector("#settings");
const bridgeUrl = document.querySelector("#bridgeUrl");
const bridgeToken = document.querySelector("#bridgeToken");
const whitelistEnabled = document.querySelector("#whitelistEnabled");
const whitelistOrigins = document.querySelector("#whitelistOrigins");
const language = document.querySelector("#language");
const commandHistoryLimit = document.querySelector("#commandHistoryLimit");
const status = document.querySelector("#status");

function applyLanguage(value) {
  const selected =
    value === "zh" || value === "en"
      ? value
      : navigator.language.toLowerCase().startsWith("zh")
        ? "zh"
        : "en";
  const strings = translations[selected];
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = strings[element.dataset.i18n];
  });
}

chrome.storage.local.get(defaults).then((values) => {
  bridgeUrl.value = values.bridgeUrl;
  bridgeToken.value = values.bridgeToken;
  whitelistEnabled.checked = values.whitelistEnabled;
  whitelistOrigins.value = values.whitelistOrigins.join("\n");
  language.value = values.language;
  commandHistoryLimit.value = values.commandHistoryLimit;
  applyLanguage(values.language);
});

language.addEventListener("change", () => applyLanguage(language.value));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.local.set({
    bridgeUrl: bridgeUrl.value.trim(),
    bridgeToken: bridgeToken.value.trim(),
    whitelistEnabled: whitelistEnabled.checked,
    whitelistOrigins: whitelistOrigins.value
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
    language: language.value,
    commandHistoryLimit: Math.max(1, Math.min(200, Number(commandHistoryLimit.value) || 50)),
  });
  status.textContent = translations[language.value === "zh" ? "zh" : "en"].saved;
  setTimeout(() => {
    status.textContent = "";
  }, 1500);
});
