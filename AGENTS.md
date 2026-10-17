# Agent guidance

- The implementation is split into `packages/remote-userscript` (TypeScript compiled userscript) and `packages/cdp-bridge` (TypeScript HTTP/CDP WebSocket bridge); use the root pnpm workspace rather than adding a third runtime package casually.
- Use pnpm commands and Biome; verified checks are `pnpm install`, `pnpm build`, and `pnpm check`.
- Follow the intended implementation order: userscript MVP → Node.js WebSocket relay → Manifest V3 extension → Edge/Android compatibility validation.
- Keep page control (DOM, input, scrolling, and console capture) separate from transport (WebSocket, authentication, reconnect, and storage); this separation is the planned migration boundary.
- Use the JSON message shape documented in `docs/message-protocol.md`: every request and response has the same unique `id`; return structured errors rather than allowing missing elements to crash the controller.
- Prefer fixed commands (`get_page_info`, `get_dom_summary`, `query`, `click`, `input`, `scroll`, `get_console`) over arbitrary JavaScript. Any future `eval_safe` must enforce authorization, domain allowlisting, timeouts, output limits, auditing, and sensitive-data restrictions.
- Treat `docs/implementation-plan.md` and `docs/userscript-to-extension.md` as the source of the planned architecture and migration constraints; update them when the implementation diverges.
- Security is a design requirement: use authenticated `wss://`, permission checks, and reconnect/timeout handling; never expose an unauthenticated remote-control port or upload passwords, cookies, or sensitive page content by default.
- For the extension phase, account for isolated content-script worlds, `document_start` for early console capture, and the fact that MV3 service workers can be suspended; do not assume a persistent WebSocket.
