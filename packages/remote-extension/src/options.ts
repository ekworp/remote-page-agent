// @ts-nocheck

export {};

const defaults = {
  bridgeUrl: "ws://localhost:9222/agent",
  bridgeToken: "",
  whitelistEnabled: false,
  whitelistOrigins: [],
  language: "auto",
  commandHistoryLimit: 50,
  consoleLevel: "warn",
};
const translations = {
  en: {
    title: "Remote Page Agent settings",
    intro: "Configure the bridge connection and the pages it can access.",
    connectionSection: "Connection",
    connectionDescription: "Set the WebSocket bridge used by the extension.",
    accessSection: "Page access",
    accessDescription: "Limit connections to the origins listed below.",
    preferencesSection: "Preferences",
    bridgeUrl: "Bridge WebSocket URL",
    token: "Connection token",
    whitelistEnabled: "Only connect on allowed origins",
    whitelistOrigins: "Allowed origins, one per line",
    language: "Interface language",
    historyLimit: "Maximum history entries",
    save: "Save settings",
    saved: "Saved",
    originAdded: "Origin added",
    noPage: "No web page found in the active window",
    invalidPage: "The active page has no valid web origin",
    consoleLevel: "Console forwarding level",
    consoleAll: "All messages",
    consoleWarn: "Warnings and errors",
    consoleError: "Errors only",
    consoleOff: "Disabled",
    testBridge: "Test bridge",
    testingBridge: "Testing…",
    bridgeSuccess: "Bridge connection successful",
    bridgeFailed: "Bridge test failed: ",
  },
  zh: {
    title: "网页操盘手设置",
    intro: "设置中转服务器地址，并管理可访问的网页。",
    connectionSection: "连接设置",
    connectionDescription: "设置扩展使用的 WebSocket 桥接地址。",
    accessSection: "页面访问",
    accessDescription: "限制扩展只连接下面列出的网页来源。",
    preferencesSection: "偏好设置",
    bridgeUrl: "Bridge WebSocket 地址",
    token: "连接密码",
    whitelistEnabled: "只连接白名单中的页面",
    whitelistOrigins: "允许的来源，每行一个",
    language: "界面语言",
    historyLimit: "最多保留历史条数",
    save: "保存",
    saved: "已保存",
    originAdded: "已加入来源",
    noPage: "当前窗口没有找到网页",
    invalidPage: "当前页面没有有效的网页来源",
    consoleLevel: "Console 转发级别",
    consoleAll: "全部消息",
    consoleWarn: "警告和错误",
    consoleError: "仅错误",
    consoleOff: "关闭",
    testBridge: "测试 Bridge 连接",
    testingBridge: "正在测试…",
    bridgeSuccess: "Bridge 连接成功",
    bridgeFailed: "Bridge 测试失败：",
  },
};
const form = document.querySelector("#settings");
const bridgeUrl = document.querySelector("#bridgeUrl");
const bridgeToken = document.querySelector("#bridgeToken");
const whitelistEnabled = document.querySelector("#whitelistEnabled");
const whitelistOrigins = document.querySelector("#whitelistOrigins");
const language = document.querySelector("#language");
const commandHistoryLimit = document.querySelector("#commandHistoryLimit");
const consoleLevel = document.querySelector("#consoleLevel");
const status = document.querySelector("#status");
const testBridgeButton = document.querySelector("#testBridge");
const bridgeTestStatus = document.querySelector("#bridgeTestStatus");

function selectedLanguage() {
  return language.value === "zh" || language.value === "en"
    ? language.value
    : navigator.language.toLowerCase().startsWith("zh")
      ? "zh"
      : "en";
}

function message(key) {
  return translations[selectedLanguage()][key];
}

function applyLanguage(value) {
  const selected =
    value === "zh" || value === "en"
      ? value
      : navigator.language.toLowerCase().startsWith("zh")
        ? "zh"
        : "en";
  const strings = translations[selected];
  document.title = strings.title;
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
  consoleLevel.value = values.consoleLevel;
  applyLanguage(values.language);
});

language.addEventListener("change", () => applyLanguage(language.value));

testBridgeButton.addEventListener("click", async () => {
  const strings = translations[selectedLanguage()];
  testBridgeButton.disabled = true;
  bridgeTestStatus.className = "small text-body-secondary";
  bridgeTestStatus.textContent = strings.testingBridge;
  try {
    const result = await chrome.runtime.sendMessage({
      type: "test_bridge",
      bridgeUrl: bridgeUrl.value.trim(),
      bridgeToken: bridgeToken.value.trim(),
    });
    bridgeTestStatus.className = result?.ok ? "small text-success" : "small text-danger";
    bridgeTestStatus.textContent = result?.ok
      ? strings.bridgeSuccess
      : `${strings.bridgeFailed}${result?.error || "Unknown error"}`;
  } catch (error) {
    bridgeTestStatus.className = "small text-danger";
    bridgeTestStatus.textContent = `${strings.bridgeFailed}${error?.message || error}`;
  } finally {
    testBridgeButton.disabled = false;
  }
});

function originList() {
  return whitelistOrigins.value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

async function saveSettings() {
  await chrome.storage.local.set({
    bridgeUrl: bridgeUrl.value.trim(),
    bridgeToken: bridgeToken.value.trim(),
    whitelistEnabled: whitelistEnabled.checked,
    whitelistOrigins: originList(),
    language: language.value,
    commandHistoryLimit: Math.max(1, Math.min(200, Number(commandHistoryLimit.value) || 50)),
    consoleLevel: ["all", "warn", "error", "off"].includes(consoleLevel.value)
      ? consoleLevel.value
      : "all",
  });
}

function showStatus(text) {
  status.textContent = text;
  setTimeout(() => {
    status.textContent = "";
  }, 1500);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveSettings();
  showStatus(message("saved"));
});
