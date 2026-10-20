# Remote Page Agent

![Remote Page Agent](assets/remote-page-agent.svg)

Remote Page Agent connects an agent to a page in a mobile browser. A userscript runs in the page and communicates with a small Node.js bridge over WebSocket. The bridge provides a limited CDP endpoint, so existing CDP clients can connect without enabling Chrome remote debugging on the phone.

This is an early prototype. Do not expose it directly to the public internet.

## Features

- Connect several pages from the same browser
- Keep a browser ID and a separate page ID for each connection
- Read page information and console messages
- Find elements with CSS selectors
- Click, type, scroll, and navigate
- Restrict automatic connections with an origin whitelist
- Configure the floating button opacity and command history size
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

You need Node.js 20 or newer and pnpm.

```bash
pnpm install
pnpm build
pnpm check
pnpm --filter @remote-page-agent/cdp-bridge start
```

The bridge listens on port `9222` by default. To allow a phone on the same LAN to connect:

```bash
HOST=0.0.0.0 PUBLIC_HOST=192.168.1.10 \
  pnpm --filter @remote-page-agent/cdp-bridge start
```

Install `packages/remote-userscript/dist/remote-agent.user.js` in Tampermonkey or another userscript manager. Open the script menu and choose **Configure Remote Page Agent**. The default URL is `ws://localhost:9222/agent`. If the bridge runs on another device, replace `localhost` with that device's LAN address.

The userscript manager stores the bridge URL, browser ID, and other settings outside the page's `localStorage`. Pages and domains using the same script installation share these settings, while each page keeps its own connection and page ID.

Configure the MCP client to use the bridge's CDP endpoint:

```text
http://server-address:9222
```

## Security

The bridge supports an optional shared token. It still uses plain WebSocket connections and allows limited JavaScript evaluation, so keep it on a trusted network. If you need to run it outside a private network, use the token and add WSS, origin checks, command permissions, timeouts, and stricter evaluation rules. Do not send passwords, cookies, or other sensitive page data by default.

## More notes

- `docs/message-protocol.md` describes the userscript/bridge message format.
- `docs/implementation-plan.md` records the planned phases.
- `docs/userscript-to-extension.md` describes the future extension migration.

## 中文说明

Remote Page Agent 通过油猴脚本连接手机浏览器中的网页。脚本通过 WebSocket 与 Node.js 桥接服务通信，桥接服务提供有限的 CDP 接口，因此不需要在手机浏览器上开启 Chrome 远程调试。

当前可以：

- 连接同一浏览器中的多个页面
- 为浏览器和每个页面维护独立标识
- 读取页面信息和控制台消息
- 使用 CSS 选择器查找元素
- 点击、输入、滚动和导航
- 执行受限的页面 JavaScript
- 通过 origin 白名单限制自动连接页面
- 在油猴脚本中配置悬浮按钮透明度和命令历史条数
- 通过 `/json/list` 和简化的 CDP WebSocket API 暴露页面

### 项目结构

```text
packages/
├── remote-userscript/  # 在手机浏览器中运行
└── cdp-bridge/         # WebSocket 服务和 CDP 适配器
docs/                   # 协议和迁移说明
```

### 本地运行

需要 Node.js 20 或更高版本，以及 pnpm。

```bash
pnpm install
pnpm build
pnpm check
pnpm --filter @remote-page-agent/cdp-bridge start
```

桥接服务默认监听 `9222` 端口。要让同一局域网中的手机连接，可以这样启动：

```bash
HOST=0.0.0.0 PUBLIC_HOST=192.168.1.10 \
  pnpm --filter @remote-page-agent/cdp-bridge start
```

将 `packages/remote-userscript/dist/remote-agent.user.js` 安装到 Tampermonkey 或其他油猴脚本管理器中，然后从脚本菜单打开 **连接设置**。默认地址是 `ws://localhost:9222/agent`。如果桥接服务运行在其他设备上，请将 `localhost` 替换为该设备的局域网地址。

桥接地址、浏览器标识和其他设置由油猴脚本管理器保存，不写入页面的 `localStorage`。同一脚本安装下的不同页面和域名共享这些设置，但每个页面仍使用独立的连接和页面标识。

将 MCP 客户端配置为使用桥接服务的 CDP 地址：

```text
http://server-address:9222
```

### 安全说明

桥接服务支持可选的共享令牌，但目前仍使用普通 WebSocket，并允许有限的 JavaScript 评估，因此请只在可信网络中使用。如果需要在私有网络之外运行，应启用令牌，并增加 WSS、来源校验、命令权限、超时和更严格的脚本执行限制。默认不要发送密码、Cookie 或其他敏感页面数据。

### 更多说明

- `docs/message-protocol.md`：油猴脚本与桥接服务的消息格式。
- `docs/implementation-plan.md`：计划中的实现阶段。
- `docs/userscript-to-extension.md`：未来迁移到浏览器扩展的说明。
