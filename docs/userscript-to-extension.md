# 油猴脚本迁移到浏览器扩展

## 可以直接复用

以下代码通常可以放入扩展的 content script：

- `document.querySelector`
- DOM 创建、修改和事件监听
- `MutationObserver`
- 普通的页面状态读取
- 点击、输入和滚动逻辑

## 需要替换的 API

| 油猴能力 | 扩展实现 |
|---|---|
| `GM_getValue` / `GM_setValue` | `chrome.storage.local` |
| `GM_xmlhttpRequest` | `fetch` 或 service worker 转发 |
| `GM_addStyle` | 注入 `<style>` |
| `GM_registerMenuCommand` | popup、右键菜单或 commands |
| `@require` | 构建时打包，避免远程代码 |
| `@connect` | `host_permissions` |
| `unsafeWindow` | MAIN world 注入或 `postMessage` |

## 推荐的扩展最小结构

```text
extension/
├── manifest.json
├── content.js
├── service-worker.js
└── popup.html
```

## 关键注意事项

1. Content script 默认运行在隔离环境，不能直接读取页面脚本的全局变量。
2. 需要早期 console 捕获时使用 `run_at: document_start`。
3. MV3 的 service worker 会被浏览器挂起，不能假设 WebSocket 永远保持。
4. `@require` 的远程代码应在构建时打包进扩展。
5. `<all_urls>`、任意 JS 执行和远程控制权限会增加商店审核难度。
6. 不要让服务器直接下发并执行未知扩展代码；优先采用固定命令协议。

## 迁移顺序

1. 先让油猴脚本只依赖标准 DOM API。
2. 把通信封装成独立 `transport` 模块。
3. 把 `GM_*` 调用集中到一个适配层。
4. 将 DOM 控制模块复制到 content script。
5. 将 WebSocket 和存储逻辑迁移到 service worker/扩展页面。
6. 最后再添加 Edge 权限、商店元数据和隐私政策。
