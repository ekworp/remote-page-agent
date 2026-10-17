# Remote Page Agent

远程网页 Agent 的实施规划：先用油猴脚本验证网页控制能力，成功后再迁移为浏览器扩展。

## 目标

手机或桌面浏览器打开目标网页后，远程 Agent 能够：

- 查看 `console` 日志
- 读取 DOM 和页面状态
- 执行受控 JavaScript
- 查询元素、点击、输入、滚动
- 通过 WebSocket 与远程服务保持连接

## 推荐路线

```text
阶段 1：油猴脚本验证网页控制逻辑
       ↓
阶段 2：Node.js WebSocket 中转服务
       ↓
阶段 3：把脚本迁移为 Manifest V3 浏览器扩展
       ↓
阶段 4：验证 Edge/Android 的实际兼容性
```

## 目录建议

```text
remote-page-agent/
├── userscript/       # 第一阶段：油猴脚本
├── relay-server/     # Node.js 中转服务
├── extension/        # 第二阶段：浏览器扩展
├── docs/             # 协议、权限和迁移记录
└── README.md
```

详细方案见：

- `docs/implementation-plan.md`
- `docs/message-protocol.md`
- `docs/userscript-to-extension.md`

## 当前初版

仓库现在包含两个 pnpm workspace package：

- `packages/remote-userscript`：TypeScript 油猴脚本，连接手机页面并执行基础页面操作。
- `packages/cdp-bridge`：提供 `/json/version`、`/json/list` 和最小 CDP WebSocket，将 CDP 请求转换为油猴脚本命令。

安装、构建和检查：

```bash
pnpm install
pnpm build
pnpm check
```

启动桥接服务：

```bash
pnpm --filter @remote-page-agent/cdp-bridge start
```

将 `packages/remote-userscript/dist/remote-agent.user.js` 安装到手机油猴，并把脚本中的
`bridgeUrl` 改为手机可访问的 `ws://服务器地址:8787/agent`。然后让 MCP 客户端连接
`http://服务器地址:8787` 的 CDP endpoint。当前版本只覆盖页面信息、导航、选择器查询、点击、输入、滚动和基础 `Runtime.evaluate`。

## 发布

推送 `v*` 标签会自动构建并创建 GitHub Release：

```bash
git tag v0.1.0
git push origin v0.1.0
```

Release 会包含完整构建包和可直接安装的 `remote-agent.user.js`。

## 重要结论

- 纯 DOM 操作的油猴脚本通常容易迁移为扩展。
- `GM_*`、`unsafeWindow`、`@require` 等油猴专有能力需要适配。
- Playwright 可以直接控制桌面 Edge，但不能绕过 Android Edge 的扩展限制。
- Edge 商店上架不等于 Android Edge 一定支持该扩展。
- 远程执行 JS 必须加认证、HTTPS/WSS、域名白名单和命令权限控制。
