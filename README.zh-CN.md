# Remote Page Agent

![Remote Page Agent](assets/remote-page-agent.svg)

[English](README.md) · [中文](README.zh-CN.md)

Remote Page Agent 让 AI 通过油猴脚本连接手机浏览器中的网页。脚本通过 WebSocket 与 Node.js 桥接服务通信，桥接服务提供有限的 CDP 接口，因此不需要在手机浏览器上开启 Chrome 远程调试。

这是一个早期原型，请不要直接暴露在公网中。

## 功能

- 连接同一浏览器中的多个页面
- 为浏览器和每个页面维护独立 ID
- 读取页面信息和控制台消息
- 使用 CSS 选择器查找元素
- 点击、输入、滚动和导航
- 通过 origin 白名单限制自动连接页面
- 配置悬浮按钮透明度和命令历史长度
- 执行受限的页面 JavaScript 命令
- 通过 `/json/list` 和简化的 CDP WebSocket API 暴露页面

## 功能状态

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 油猴脚本连接移动端页面 | ✅ 已实现 | 通过 WebSocket 连接 Node.js bridge。 |
| 多页面连接与页面标识 | ✅ 较完善 | 为浏览器和每个页面维护独立 ID，并在短暂断线后保留页面。 |
| WebSocket 心跳 | ✅ 已实现 | bridge 每 30 秒发送协议级 `ping`，用于发现失效连接。 |
| 自动重连 | ✅ 较完善 | 支持指数退避、随机延迟、网络恢复和页面回到前台后重连。 |
| 后台长时间运行 | ⚠️ 仍有问题 | 手机系统冻结或回收浏览器进程时，连接仍可能中断。 |
| 页面导航后的重连 | ✅ 已实现 | 页面刷新或导航后可以恢复同一逻辑页面连接。 |
| 页面文本、链接和页面信息读取 | ✅ 已实现 | 支持 DOM 摘要和固定页面信息读取。 |
| Accessibility Snapshot | ✅ 已实现 | 支持角色、名称、链接地址、状态和交互属性，覆盖范围仍小于完整 CDP。 |
| Snapshot 节点压缩 | ✅ 已实现 | 折叠布局节点，过滤明确的装饰 SVG，同时保留交互子节点。 |
| 点击、输入、滚动和导航 | ✅ 基本完善 | 支持普通页面和动态页面中的链接、按钮及 generic Accessibility 节点包装；点击跳转或页面销毁时仍能安全返回响应。 |
| 控制台消息读取 | ✅ 已实现 | 通过简化 CDP 接口转发页面事件。 |
| 受限页面脚本执行 | ⚠️ 有意限制 | 只允许固定命令和有限表达式，不支持任意 JavaScript。 |
| Origin 白名单 | ✅ 已实现 | 可限制允许自动连接的页面。 |
| Token 认证 | ✅ 已实现 | 支持共享连接密码。 |
| WSS、来源校验和细粒度权限 | ❌ 未实现 | 当前版本不适合直接暴露到公网。 |
| 完整 Chrome DevTools Protocol | ❌ 未实现 | 当前只实现 Puppeteer/MCP 所需的有限子集。 |
| 浏览器扩展版本 | ⚠️ 初步实现 | `packages/remote-extension` 中已有 Chromium Manifest V3 版本，仍需继续迁移更多命令。 |

## 项目结构

```text
packages/
├── remote-userscript/  # 在手机浏览器中运行
├── remote-extension/   # Chromium Manifest V3 扩展
└── cdp-bridge/         # WebSocket 服务和 CDP 适配器
docs/                   # 协议和迁移说明
```

## 本地运行

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

## 安全说明

桥接服务支持可选的共享令牌，但目前仍使用普通 WebSocket，并允许有限的 JavaScript 评估，因此请只在可信网络中使用。如果需要在私有网络之外运行，应启用令牌，并增加 WSS、来源校验、命令权限、超时和更严格的脚本执行限制。默认不要发送密码、Cookie 或其他敏感页面数据。

## 更多说明

- `docs/message-protocol.md`：油猴脚本与桥接服务的消息格式。
- `docs/implementation-plan.md`：计划中的实现阶段。
- `docs/userscript-to-extension.md`：浏览器扩展迁移说明。
