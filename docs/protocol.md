# 适配器协议 v1（WeChat Adapter Protocol）

插件本身不碰微信。所有"读消息、发消息、登录、窗口显隐"都通过一个**适配器进程**完成，插件和适配器之间只说这份协议。
只要实现了这份协议，任何东西都可以当适配器：Windows 微信 4.x 的 UI 自动化、数据库读取、iPad 协议、Hook、甚至别的 IM。

- 参考实现：[`plugins/dsh-wechat-bot/lib/simulator.js`](../plugins/dsh-wechat-bot/lib/simulator.js)（协议完整的假微信）；[`adapters/wechat-db`](../adapters/wechat-db)（读微信本地数据库收消息；默认写发件箱，可选仓库内 Windows worker 同步发送文字）
- 插件侧客户端：[`lib/adapter.js`](../plugins/dsh-wechat-bot/lib/adapter.js)，数据校验：[`lib/protocol.js`](../plugins/dsh-wechat-bot/lib/protocol.js)
- 一致性检查工具：`node bin/check-adapter.js -- <你的适配器命令>`

本文请求中的账号、群、消息标识和正文均为虚构示例；真实验收回执与账号数据由部署者本地保管。

---

## 1. 传输

| 项 | 约定 |
| --- | --- |
| 进程 | 插件用配置里的 `adapter.command` + `adapter.args` 启动适配器（`cwd`、`env` 可配） |
| 通道 | **stdin / stdout**，UTF-8，**每行一个 JSON 对象**（JSON Lines），行尾 `\n` |
| 帧格式 | [JSON-RPC 2.0](https://www.jsonrpc.org/specification)：插件 → 适配器是**请求**（带 `id`），适配器 → 插件是**通知**（不带 `id`） |
| stderr | 随便写日志，插件逐行收集到控制台"连接日志"（debug 级），不参与协议 |
| stdout 纪律 | stdout 上只能写协议帧。Python 记得 `print(..., flush=True)` 或关掉缓冲；不要让第三方库往 stdout 打印 |
| 退出 | stdout 关闭 = 连接断开。插件会结束该进程（1 秒宽限），再以 1s/2s/5s/10s/30s 退避**自动重启**适配器，并重新走握手、登录状态检查、`watch/set`。握手失败（如协议版本不符）同样会先结束进程再重试 |

请求示例：

```json
{"jsonrpc":"2.0","id":7,"method":"message/send","params":{"chatId":"example-group@chatroom","clientId":"example-request:0","content":{"kind":"text","text":"示例消息"}}}
```

成功响应：

```json
{"jsonrpc":"2.0","id":7,"result":{"messageId":"example-message-001"}}
```

失败响应——**`error.data.code` 是插件路由用的机器码**（见第 5 节），`error.code` 用 JSON-RPC 的数值（未知方法 `-32601`，其他 `-32000`）：

```json
{"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"send button not found","data":{"code":"send_failed"}}}
```

通知示例：

```json
{"jsonrpc":"2.0","method":"event/message","params":{"message":{...}}}
```

---

## 2. 生命周期

```
插件启动适配器进程
  → initialize                      握手，交换版本和能力
  → account/status                  小号登录了吗？
     ├─ ready  → chats/list → watch/set [...]  开始推送 event/message
     └─ 未登录 → （用户在 DSH 里 /wechat 或控制台点"开始登录"）→ account/login
                  适配器完成登录后发 event/account {state:"ready"} → 插件自动 watch/set
运行中：
  ← event/message   新消息
  ← event/status    连接 / 能否发送 变化（锁屏、断网、微信崩了…）
  → message/send    发消息（插件只服务一个群，同一时间最多一条发送请求在途；命令回复可能与之并发）
  → window/get|set  控制台切换小号窗口显隐（可选能力）
插件关闭：
  → shutdown        适配器清理后退出进程
```

所有请求默认超时 30 秒，`message/send` 90 秒。

---

## 3. 方法（插件 → 适配器）

### `initialize`

```ts
params: { protocolVersion: 1, dataDir: string, client: { name: string, version: string } }
result: {
  protocolVersion: 1,                    // 必须等于 1，否则插件拒绝连接
  adapter: { name: string, version: string },
  capabilities: {
    receive?: MessageKind[],             // 能收到哪些消息类型，默认 ["text"]
    send?: ("text"|"image"|"sticker")[], // 能发哪些，默认 ["text"]
    window?: boolean,                    // 支持 window/get|set
    history?: boolean,                   // 支持 chats/history
    mediaFetch?: boolean,                // 支持 media/fetch
    simulator?: boolean                  // 只有模拟器为 true（控制台会显示"模拟一条消息"面板）
  }
}
```

`dataDir` 是插件的状态目录（默认 `~/.dsh/wechat-bot`），适配器可以在里面建自己的子目录放缓存（如密钥缓存、解密库），但不要动别的文件。

### `account/status`

```ts
params: {}
result: Account
type Account = {
  state: "offline" | "login_required" | "ready",
  self?: { id: string, name: string },   // ready 时必填（缺了插件会拒绝）：小号的微信 id（wxid）和昵称
  instructions?: string,                 // 给用户看的一句话提示
  qrCode?: string                        // 可选：登录二维码 data URL，控制台会直接显示
}
```

### `account/login`

用户要求登录时调用（DSH 里 `/wechat` 首次初始化、控制台"开始登录"按钮）。**必须立即返回**，不要阻塞到登录完成：

- 已登录 → 返回 `{ state: "ready", self }`
- 需要用户操作 → 准备好环境（如启动小号微信），返回 `{ state: "login_required", instructions: "请用手机确认小号登录", qrCode? }`；
  之后登录成功时发 **`event/account`** 通知。

### `chats/list`

```ts
params: { query?: string }               // 名称子串过滤，可忽略
result: { chats: Chat[] }
type Chat = { id: string, name: string, kind: "group" | "direct", memberCount?: number }
```

`id` 必须稳定（群用 `xxx@chatroom`，私聊用对方 wxid）。`name` 用备注名优先、其次昵称。未登录时返回错误 `not_ready`。

### `chats/members`

```ts
params: { chatId: string }
result: { members: Person[] }

type Person = {
  id: string,          // wxid：主键，身份判断只认它，改名不变
  name: string,        // 此人在这个聊天里显示的名字：群昵称 > 备注 > 昵称
  aliases?: string[],  // 可选：此人其它所有叫法（昵称、备注、群昵称、微信号），按最新数据
}
```

名字只是挂在 id 上的标签：每次读取都应给出**当前**的名字。插件用 `name` + `aliases` 按名字找人（如 `/attack 昵称`），用 `id` 判断身份；成员列表里机器人自己的群昵称也会被当作"在叫它"。不带 `aliases` 的旧适配器照样兼容。

### `chats/history`（能力 `history`）

```ts
params: { chatId: string, limit: number }
result: { messages: Message[] }          // 按时间升序，最多 limit 条，最新的在最后
```

插件开始监听某个聊天时调一次，用来给模型"补上下文"，**这些消息不会被回复**。

### `watch/set`

```ts
params: { chatIds: string[] }            // 完整列表，替换之前的；[] 表示全部停止。当前插件只服务一个群，所以最多一个
result: { watching: string[] }
```

**基线语义**：只推送调用之后**新到达**的消息（不要把旧消息当新消息推）。适配器重启后插件会再调一次。

`wechat-db` 的独立窗口模式在安全准备失败后，显式重复设置同一目标可重新准备窗口；准备中或已就绪时重复设置保持幂等。此前 gate 或 worker 清理未确认则仍拒绝重试，不改变发送日志的去重语义。

### `message/send`

```ts
params: {
  chatId: string,
  clientId: string,                      // 幂等键，见下
  content:
    | { kind: "text", text: string, mentions?: string[] }   // mentions: 要 @ 的 wxid（预留）
    | { kind: "image", path: string }                       // 本地图片绝对路径
    | { kind: "sticker", path?: string, stickerId?: string }
}
result: { messageId: string }            // 这条消息在微信里的 id，用来和 event/message 的回显对上
```

**必须遵守的语义：**

1. **幂等**：同一个 `clientId` 第二次到达时，**不能再发一次**，直接返回第一次的结果。插件只会在确定失败（`send_failed`）后用同一个 `clientId` 重试。
2. **失败要分清楚**（这是防止重复发言/漏发的关键）：
   - `send_failed`：**确定没发出去**（例如找不到输入框、草稿没写进去）。插件会退避重试最多 2 次。
   - `send_uncertain`：**不确定**（例如点了发送但没在数据库里看到回显）。插件**永不重试**，只记日志。
   - `unavailable`：**现在发不了，什么都没做**（例如锁屏期间无法操作 UI）。插件等待 `event/status canSend:true` 后再试；回复超过 10 分钟（可配）就丢弃，不会把过时回复补发出去。
3. **回显**：发出去的消息之后也应作为 `event/message`（`fromSelf: true`）推送一次。`id` 等于返回的 `messageId` 时按 id 去重；不相等时（例如适配器只是把内容排进了队列，真正发出后数据库里是另一个 id），插件在 2 分钟内按正文匹配去重。没有回显也能工作。

   `adapters/wechat-db` 默认是"排队"式：写进发件箱后返回 `out:<clientId>`，此回执只代表入箱；消费者尚未实现。显式设置 `--sender-config` 后改为同步文字发送：通过仓库内 `native-runtime` 的隐藏桌面 worker 在配置的主窗口或已准备的独立窗口中发送，真实数据库出站核对通过才返回微信 id，持久日志保证跨重启不重复；不消费或补发默认发件箱的旧记录。该路径依赖 wx4py、本机微信版本与控件门参数匹配，不依赖旧项目目录；不支持媒体发送和非空 mentions。
4. 命令的直接回复可能与普通回复**并发**调用 `message/send`，适配器必须自己串行化对同一个微信实例的操作。

当前实现的真实验收记录（2026-10-22）：测试账号真实加密库、与测试联系人私聊的真实模型回复已通过；测试群会话选择、双击打开独立窗口、native文字发送和精确数据库回执已通过。正式 `/help` 的收件与回件已核对；`/ask` 的三段模型回复全部与数据库核对，`modelErrors`、`sendErrors` 均为0。公开文档不包含真实账号及回执标识。这是当前单活动会话的短期文字收发证据，不代表群长期稳定性、多会话并行、锁屏恢复或媒体能力。

### `media/fetch`（能力 `mediaFetch`，预留给图片/表情包识别）

```ts
params: { chatId: string, messageId: string }
result: { path: string, mime: string, width?: number, height?: number }   // 解密后的本地文件
```

### `window/get` / `window/set`（能力 `window`）

```ts
window/get  params: {}                    result: { visible: boolean, running?: boolean }
window/set  params: { visible: boolean }  result: { visible: boolean, running?: boolean }
```

控制台已有的显隐开关。`wechat-db` 在本地发送配置启用 `desktopControl:true` 时声明此能力：用户主动显示会进入小号专用桌面，缺少进程时启动登录窗口；切换前必须备好返回工具栏。用户点击“返回主桌面”或 `visible:false` 时返回 Default，小号继续后台运行。后台收发不会自行切换输入桌面；显示期间发送按桌面可用性约束等待。锁屏或无关输入桌面返回 `unavailable`，非法 visible 返回 `invalid_params`。

`preparedBinding` 是适配器内部窗口快照，不是协议字段。选择会话、准备状态及 `message/send` 的幂等/回执语义保持不变；失效的绑定不能通过显隐接口绕过恢复门禁。

### `shutdown`

```ts
params: {}  result: {}
```

返回后尽快退出进程（插件 3 秒后会强制结束）。

---

## 4. 通知（适配器 → 插件）

### `event/message`

```ts
params: { message: Message }

type Message = {
  id: string,               // 必填。全局唯一且稳定：适配器重启后同一条消息必须还是同一个 id（插件靠它去重）
  chatId: string,           // 必填。和 chats/list 的 id 一致
  time: number,             // 必填。毫秒时间戳
  kind: "text" | "image" | "sticker" | "voice" | "video" | "file" | "link" | "system" | "other",
  text?: string,            // text 必填；其他类型可放简短描述或占位（如"[图片]"）
  sender: Person,           // 必填。id 是真实 wxid——身份判断只认它；name/aliases 同 chats/members，取发消息时的最新值
  fromSelf?: boolean,       // 小号自己发的（含插件发的回显、有人在小号的手机上发的）
  mentions?: string[],      // 这条消息 @ 了谁（wxid 列表），@所有人 用 "all"。
                            // 请从消息元数据（如 msgsource 的 atuserlist）取，不要从正文猜
  quote?: {                 // 引用 / 回复了哪条消息。尽量给 senderId；只给 messageId 时插件会在
    messageId?: string,     // 本地上下文里查发送者，查不到就不当作"在跟别人说"
    senderId?: string, senderName?: string, text?: string
  },
  media?: { mime?: string, description?: string }   // 非文字消息：description 会原样给模型看，
                                                    // 适配器可以在这里放 OCR / 图片描述 / 表情包含义
}
```

字段的作用（插件怎么用它们）：

| 字段 | 用途 |
| --- | --- |
| `mentions` 含小号 id | 判定"在跟机器人说话"（最强信号） |
| `quote.senderId` 是小号 | 判定"在回机器人的话" |
| `quote.senderId` 是别人 / `mentions` 是别人 | 判定"在跟别人说话"，模型默认不插嘴 |
| `sender.id` | 长期记忆归属、成员身份（**昵称无效**） |
| `fromSelf` | 不触发回复，只作为上下文 |
| `kind` / `media.description` | 非文字消息转成 `[图片: …]`、`[表情: …]` 给模型 |

### `event/status`

```ts
params: {
  connection: "connected" | "degraded" | "disconnected",
  canSend: boolean,         // 现在能不能发消息
  reason?: string,          // 机器码，例如 "screen_locked" / "client_closed" / "logged_out"
  detail?: string           // 给人看的说明
}
```

状态变化时发（不用定时发）。`canSend: false` 时插件**照常收消息、照常思考**，回复排队等待；变回 `true` 后发送，过时的丢弃。
从不发 `event/status` 的适配器，登录后被视为 `connected, canSend: true`；发过的以适配器说的为准。

`wechat-db` 真实发送模式使用以下原因码，均保持 `canSend:false`：`sender_preparing` 表示独立窗口准备中；`sender_prepare_failed` 表示已安全清理的准备失败，可由用户重新准备；`sender_recovery_required` 表示恢复未确认，禁止重试。`detail` 为可公开显示的固定说明或经过筛选的原因码，不包含本机密钥、路径或原始异常文本。

### `event/account`

```ts
params: Account            // 同 account/status 的返回
```

登录完成、被踢下线、切换账号时发。

### `event/log`

```ts
params: { level: "debug" | "info" | "warn" | "error", message: string }
```

显示在控制台"连接日志"。比 stderr 更正式，适合给用户看的事件。

---

## 5. 错误码（`error.data.code`）

| code | 含义 | 插件行为 |
| --- | --- | --- |
| `invalid_params` | 参数不合法 | 记错误 |
| `not_ready` | 未登录 / 未初始化 | 提示登录 |
| `not_found` | 聊天或消息不存在 | 记错误 |
| `unsupported` | 不支持的能力 | 控制台隐藏对应功能 |
| `send_failed` | **确定**没发出 | 同 `clientId` 退避重试（最多 2 次） |
| `send_uncertain` | 可能发出了 | **不重试**，记日志 |
| `unavailable` | 暂时不能发，什么都没做 | 等 `canSend: true` 后重试，超时丢弃 |
| 其他 / 超时 / 进程退出 | — | 按 `send_uncertain` 处理（宁可漏发不可重发） |

---

## 6. 锁屏要求

收消息建议直接读微信本地数据库（不依赖界面和桌面状态）。插件这一侧也完全不依赖桌面：收消息、合批、调模型、写记忆都在锁屏时照常进行。能不能**在锁屏时发出去**完全取决于适配器：

- 能发：保持 `canSend: true`，正常处理 `message/send`。
- 暂时不能：发 `event/status { canSend: false, reason: "screen_locked" }`，在 `message/send` 里返回 `unavailable`；解锁后发 `canSend: true`。

`screen_locked` 是已经确认锁屏时的示例原因码。数据库适配器的可选旧发送后端只能确认桌面是否可用，或是否存在未核验的 worker 恢复，因此使用 `sender_unavailable`，不把所有不可用情况都诊断成锁屏；等待和恢复仍由 `canSend` 驱动。

---

## 7. 一致性检查

```bash
node bin/check-adapter.js -- python -u my_adapter.py           # 只读检查：握手、登录状态、聊天列表、成员、错误码
node bin/check-adapter.js --watch example-group@chatroom --wait 60 -- …   # 打印 60 秒内收到的消息（替换示例群ID）
node bin/check-adapter.js --send wxid_example -- …                       # 真的发一条 "adapter check"，并验证 clientId 幂等
```

插件端用模拟器跑的单元/场景测试也就是这份协议的活文档：`plugins/dsh-wechat-bot/test/protocol.test.js`。
