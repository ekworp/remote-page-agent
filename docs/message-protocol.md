# Agent 消息协议建议

所有消息使用 JSON，并带有唯一 `id`。

## 请求

```json
{
  "id": "req-001",
  "type": "query",
  "payload": {
    "selector": "h1"
  }
}
```

## 响应

```json
{
  "id": "req-001",
  "ok": true,
  "result": {
    "text": "页面标题"
  }
}
```

## 错误

```json
{
  "id": "req-001",
  "ok": false,
  "error": {
    "code": "ELEMENT_NOT_FOUND",
    "message": "找不到目标元素"
  }
}
```

## 建议的初始命令

```text
get_page_info
get_dom_summary
query
click
input
scroll
get_console
get_dom_summary
eval_safe
wait_for_stable_dom
```

`wait_for_stable_dom` waits until the page has had no DOM mutations for the
requested quiet period, then returns `{ "stable": true, "timedOut": false, "quietMs": 100 }`.
It also accepts an optional `maxWaitMs` hard deadline. If the deadline is
reached first, it returns `stable: false` and `timedOut: true`. The client
clamps both periods to safe ranges and uses a fixed `MutationObserver`
implementation; it does not evaluate caller-supplied code.

`eval_safe` 不建议一开始接受任意代码。优先实现固定命令；如果确实需要任意 JS，至少增加：

- 用户或设备级授权
- 域名白名单
- 超时限制
- 最大返回长度
- 审计日志
- 禁止访问 Cookie、Storage、密码字段等敏感数据的策略

## 页面事件

页面事件通过 `page_event` 消息转发到 CDP 客户端，当前包括：

- `Page.loadEventFired`
- `Page.lifecycleEvent`
- `Page.frameNavigated`
- `Page.navigatedWithinDocument`
- `Network.online`
- `Network.offline`

`Network.online` 和 `Network.offline` 是 bridge 提供的状态通知事件，不是需要调用的 CDP 命令。

## Console 消息

页面 Console 通过 `console` 消息转发到 bridge：

```json
{
  "type": "console",
  "method": "warn",
  "args": ["navigation warning"],
  "url": "https://example.com/"
}
```

`method` 支持 `log`、`warn` 和 `error`。客户端默认只转发 `warn` 和 `error`，也可以配置为转发全部消息、仅错误或关闭转发。

为避免高动态页面造成 WebSocket 和 CDP 堵塞，客户端在 10 秒窗口内最多转发 50 条 Console 消息和 20 条页面事件；bridge 端还会执行独立的服务端限流。
