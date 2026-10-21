const defaults = { bridgeUrl: "ws://localhost:9222/agent", bridgeToken: "" };
const form = document.querySelector("#settings");
const bridgeUrl = document.querySelector("#bridgeUrl");
const bridgeToken = document.querySelector("#bridgeToken");
const status = document.querySelector("#status");

chrome.storage.local.get(defaults).then((values) => {
  bridgeUrl.value = values.bridgeUrl;
  bridgeToken.value = values.bridgeToken;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.local.set({
    bridgeUrl: bridgeUrl.value.trim(),
    bridgeToken: bridgeToken.value.trim(),
  });
  status.textContent = "Saved";
  setTimeout(() => {
    status.textContent = "";
  }, 1500);
});
