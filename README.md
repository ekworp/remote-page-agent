# Remote Page Agent

![Remote Page Agent](assets/remote-page-agent.svg)

Remote Page Agent lets an agent work with a page opened in a mobile browser. The page runs a userscript, which talks to a small Node.js bridge over WebSocket. The bridge exposes a limited CDP endpoint, so tools that already speak CDP can connect without Chrome remote debugging on the phone.

This is an early prototype, not a ready-to-expose service.

## What it can do

- Connect several pages from the same browser
- Keep a browser ID and a separate page ID for each connection
- Read page information and console messages
- Find elements with CSS selectors
- Click, type, scroll, and navigate
- Run limited page-side JavaScript
- Expose connected pages through `/json/list` and a small CDP WebSocket API

## Project layout

```text
packages/
├── remote-userscript/  # Runs in the mobile browser
└── cdp-bridge/         # WebSocket server and CDP adapter
docs/                   # Protocol and migration notes
```

## Run it locally

Requirements: Node.js 20 or newer and pnpm.

```bash
pnpm install
pnpm build
pnpm check
pnpm --filter @remote-page-agent/cdp-bridge start
```

The bridge listens on port `9222` by default. To let a phone on the LAN connect:

```bash
HOST=0.0.0.0 PUBLIC_HOST=192.168.1.10 \
  pnpm --filter @remote-page-agent/cdp-bridge start
```

Install `packages/remote-userscript/dist/remote-agent.user.js` in Tampermonkey or another userscript manager. Open its menu and choose **Configure Remote Page Agent**. The default URL is `ws://localhost:9222/agent`; replace `localhost` with the bridge server's LAN address when the server is on another device.

The bridge URL and browser ID are stored with the userscript manager, not in page `localStorage`. That means different pages and domains using the same userscript installation share the same settings. Each page still gets its own connection and page ID.

Point the MCP client at the bridge's CDP endpoint:

```text
http://server-address:9222
```

## Security

The prototype currently uses plain WebSocket connections, has no authentication, and allows limited JavaScript evaluation. Keep it on a trusted network. Before exposing it outside a private network, add authentication, WSS, origin checks, command permissions, timeouts, and stricter evaluation rules. Do not send passwords, cookies, or other sensitive page data by default.

## More notes

- `docs/message-protocol.md` describes the userscript/bridge message format.
- `docs/implementation-plan.md` records the planned phases.
- `docs/userscript-to-extension.md` describes the future extension migration.

## 中文说明

Remote Page Agent 用油猴脚本控制手机浏览器中的网页。脚本通过 WebSocket 连接 Node.js 桥接服务，桥接服务提供一组有限的 CDP 接口，因此不需要在手机浏览器上开启 Chrome 远程调试。

当前版本支持多个页面连接。油猴脚本管理器保存一个浏览器标识和远程地址，每个页面连接使用独立的页面标识。默认端口是 `9222`，可通过油猴菜单修改地址。

这是功能验证原型，不要直接暴露到公网。正式使用前需要加入认证、WSS、来源校验、命令权限和更严格的脚本执行限制。
