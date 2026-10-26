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

## CDP 兼容层注意事项

`cdp-bridge` 不是完整浏览器，只需要覆盖 `chrome-devtools-mcp` / Puppeteer 实际依赖的协议子集：

- 扁平化会话中的事件必须带顶层 `sessionId`，例如 `Runtime.executionContextCreated`。否则 Puppeteer 会把事件交给浏览器连接而不是页面会话，`evaluate_script` 会一直等待执行上下文并超时。
- 浏览器级 `Target.setAutoAttach` 可以为每个页面创建会话；会话级 `Target.setAutoAttach` 不应再次附加当前页面，否则会递归产生 `Target.attachedToTarget`。
- `Target.getDevToolsTarget` 的正确返回是可选 `targetId`。没有 DevTools 页面时返回 `{}`，Puppeteer 会按“没有 DevTools”处理。
- `Runtime.evaluate` 返回函数时，需要提供 `objectId` 供后续 `Runtime.callFunctionOn` 使用；`Runtime.callFunctionOn` 本身始终表示执行函数，不能用来“创建函数句柄”。
- `Page.getFrameTree` / `Page.getResourceTree` 的 `frame.id` 必须与 `Runtime.executionContextCreated` 的 `auxData.frameId` 一致，`Page.createIsolatedWorld` 也应返回对应的 `executionContextId` 并发送上下文事件。
- 页面身份必须稳定。油猴脚本用 `sessionStorage` 保存 `pageId`，同一标签页导航后继续使用同一 targetId；如果另一个仍然存活的页面报告了相同 pageId（复制标签页可能复制 sessionStorage），Bridge 必须分配新的 targetId 并通过 `hello_ack` 通知页面，不能让两个页面共享会话。
- 页面断开后保留 `PAGE_RECONNECT_GRACE_MS` 宽限期，期间重连只发送 `Target.targetInfoChanged` 和页面导航事件；超过宽限期后先发送 `Target.detachedFromTarget`，再发送一次 `Target.targetDestroyed`。新页面连接时只向已经 `setAutoAttach` 的客户端发送 `Target.attachedToTarget`，并用幂等集合避免重复 targetCreated/attach。
- `Target.getTargets` 只返回当前 pages，不重放 `targetCreated`；`setDiscoverTargets` / `setAutoAttach` 应先返回命令响应，再异步发送当前目标事件。这样 Puppeteer/MCP 的 target 缓存不会因为重复或过早事件而错位。
- Puppeteer 会把 DOM 元素作为 `Runtime.callFunctionOn` 的 `arguments` 传入，而不是放在顶层 `objectId`。点击链路依赖 `DOM.describeNode({objectId})`、`DOM.resolveNode`、`DOM.getContentQuads` 以及固定操作 `dom_operation`（rect / client_rects / is_intersecting / scroll_into_view / click）。
- `Runtime.callFunctionOn` 返回新的 DOM handle 时不能复用传入的 `objectId`；Puppeteer 会释放临时 handle，复用会导致返回的 ElementHandle 立即失效。
- AX 中的 `generic` 节点经常只是包装层，可能没有布局盒子。`rect`、`client_rects`、`stable_rects`、`is_intersecting`、`scroll_into_view` 和点击坐标都应解析到最近的可点击祖先或可布局容器，而不是只使用原始节点。
- `getBoundingClientRect()` 的桥接结果应包含 `x/y/width/height/top/left/right/bottom`；`getClientRects` 必须返回数组。`stable_rects` 应保证两次矩形一致，避免轮播或懒加载动画导致 Locator 的 actionability 永远无法通过。
- 移动端卡片经常位于内部滚动容器中。`scroll_into_view` 需要临时关闭滚动容器的 `scroll-behavior`，并在 `scrollIntoView` 后返回最新矩形。
- 点击前要跳过 Remote DevTools 自己的悬浮窗遮挡；鼠标释放后只执行一次元素激活行为，避免重复 `click`。激活行为必须通过 `setTimeout(0)` 延后到响应发送之后：导航或 `_blank` popup 可能立即销毁当前文档，若同步 `.click()` 会丢掉 WebSocket 响应，让 MCP 误报 actionability 超时。
- Bridge 在页面 socket 关闭时，应立即结束该页面的 pending 请求；点击/按键类请求按“已送达并可能触发导航”处理为成功，其他请求返回 Page disconnected，避免等待 15s agent timeout。
- Puppeteer 的 `Locator.fill()` 会先调用一个类型探测函数（返回 `typeable-input` / `checkable-input` / `select` / `contenteditable`），再对短文本调用“计算剩余文本 + type()”的函数，对长文本调用直接赋值函数。Bridge 必须识别这些函数形状并转换为固定 `get_input_kind`、`fill`、`get_checked`、`select_option` 操作，不能落到 `eval_safe`。
- 固定输入操作只修改 input/textarea/select/checkbox/radio/contenteditable，按 `beforeinput -> 修改 value/checked -> input -> change` 顺序派发事件；`Input.insertText` 应按当前选区插入文本而不是覆盖整个 value。
- `Input.dispatchKeyEvent` 必须作用于 `document.activeElement`，并保留 `keyDown/keyUp/char` 类型和 `keyCode/which`。合成的 Enter 事件不会自动触发表单提交或框架的“搜索”默认行为，因此 keyUp 后应在 URL 未变化时点击附近的搜索/提交控件，或回退到 `form.requestSubmit()`。
- SPA 的 `pushState`、`replaceState`、`popstate`、`hashchange` 都需要转发页面 URL/title 变化。
- 同一标签页的逻辑页面 ID 使用 `sessionStorage` 跨文档导航复用；Bridge 在 userscript 短暂断线时保留页面和 CDP session 10 秒，重连后重绑定，超时后才发送 `Target.targetDestroyed`。
- `Target.createTarget` 通过已连接页面的固定 `open_page` 命令调用 userscript 的 `GM_openInTab`，并等待新页面使用预分配的逻辑 pageId 完成 hello；`Page.bringToFront` 在当前模型中作为兼容 no-op。
- 白名单模式只允许授权 origin 自动连接；Bridge 创建的新页面使用一次性临时授权，初始有效期 60 秒，连接后的有效操作将空闲期限延长至 5 分钟，但最长不超过 30 分钟。旧 DOM UID 不得盲目映射到新文档节点。
- Accessibility Tree 会展平无名称的 `generic`/`none` 布局包装层，保留语义角色、名称和所有交互节点，以降低复杂页面的快照体积而不破坏 UID 操作。

需要观察协议往返时，可在启动桥接服务时设置 `CDP_DEBUG=1`。日志会额外记录 DOM rect、client rect 数量、stable rects、intersection 结果、quad、Input 坐标以及实际命中的元素标签/class（截断，不记录文本内容）。

## 验收标准

- 页面跳转后连接可以恢复。
- Agent 命令有唯一 ID，并且不会串结果。
- 未认证客户端无法执行命令。
- 目标元素不存在时返回明确错误，而不是让脚本崩溃。
- 在普通页面、动态页面和单页应用中都能工作。
- 不会把密码、Cookie 或页面敏感内容默认上传。
