const MESSAGE_TYPE = "remote-page-agent-console";
const PAGE_NAVIGATION_MESSAGE_TYPE = "remote-page-agent-navigation";

function announceNavigation() {
  window.postMessage(
    { type: PAGE_NAVIGATION_MESSAGE_TYPE, url: location.href, title: document.title },
    "*",
  );
}

const originalPushState = history.pushState;
history.pushState = function (...args) {
  originalPushState.apply(this, args);
  announceNavigation();
};
const originalReplaceState = history.replaceState;
history.replaceState = function (...args) {
  originalReplaceState.apply(this, args);
  announceNavigation();
};
window.addEventListener("popstate", announceNavigation);
window.addEventListener("hashchange", announceNavigation);

for (const method of ["log", "warn", "error"] as const) {
  const original = console[method];
  console[method] = (...args: unknown[]) => {
    original.apply(console, args);
    window.postMessage(
      {
        type: MESSAGE_TYPE,
        method,
        args: args.map((value) => {
          try {
            return String(value);
          } catch {
            return "[unserializable]";
          }
        }),
        url: location.href,
      },
      "*",
    );
  };
}
