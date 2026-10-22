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
```

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
