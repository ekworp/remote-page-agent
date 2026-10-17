# 实施方案

## 第一阶段：油猴脚本 MVP

先不要实现完整 Agent，验证以下能力：

1. 页面加载时建立连接或显示连接状态。
2. 捕获 `console.log`、`console.warn`、`console.error`。
3. 支持读取页面标题、URL 和 DOM 摘要。
4. 支持 `querySelector`、点击、输入和滚动。
5. 支持一个受控的 JS 执行命令。
6. 页面跳转后自动重新初始化。

建议使用 `@run-at document-start`，尽早安装 console hook；DOM 操作需要等待 `DOMContentLoaded` 或目标元素出现。

## 第二阶段：Node.js 中转服务

中转服务负责：

- 为设备分配唯一 ID
- 保存设备在线状态
- 转发 Agent 与浏览器之间的消息
- 校验认证 Token
- 记录请求 ID、结果和错误
- 处理断线和超时

建议所有连接使用 `wss://`。不要让浏览器端暴露一个未认证的远程控制端口。

## 第三阶段：迁移为扩展

把油猴脚本拆成两层：

```text
page-controller.js  # DOM、点击、输入、console，尽量保持不变
transport.js        # WebSocket、认证、重连，替换 GM_* 实现
```

Manifest V3 扩展通常包含：

- `content.js`：页面 DOM 操作
- `service-worker.js`：后台通信和权限 API
- `manifest.json`：匹配规则和权限
- 可选的 popup/options 页面

## 第四阶段：浏览器选择

### 官方 Edge 桌面版

Playwright 可以使用 `channel: 'msedge'` 控制页面，不需要扩展即可完成大部分 DOM、console 和 JS 操作。

### Edge 扩展

扩展可以提交 Edge Add-ons，但商店上架不保证 Android Edge 支持安装或完整运行。需要实际测试 Android Edge 的版本、扩展入口和后台连接行为。

### Playwright 加载本地扩展

Playwright 官方文档推荐使用 Playwright 自带的 Chromium 加载未打包扩展。官方 Edge/Chrome 已移除侧载扩展所需的部分命令行参数，因此不能简单依赖：

```text
--disable-extensions-except
--load-extension
```

## 验收标准

- 页面跳转后连接可以恢复。
- Agent 命令有唯一 ID，并且不会串结果。
- 未认证客户端无法执行命令。
- 目标元素不存在时返回明确错误，而不是让脚本崩溃。
- 在普通页面、动态页面和单页应用中都能工作。
- 不会把密码、Cookie 或页面敏感内容默认上传。
