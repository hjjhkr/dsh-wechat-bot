# wechat-db 适配器

按 [适配器协议 v1](../../docs/protocol.md) 工作的微信适配器：**收消息读微信本地数据库，默认发消息只输出内容 JSON；可显式接入旧隐藏桌面 worker，并通过已选独立窗口发送文字**。

| 方向 | 做法 | 状态 |
| --- | --- | --- |
| 收 | 轮询 `db_storage/message/message_N.db` 里所服务会话的 `Msg_<md5>` 表，解析成协议消息推给插件 | 测试账号真实加密库与测试联系人私聊已验证；测试群文字收件、命令与真实模型回复已验证 |
| 发 | 把要发的内容写成一行 JSON，追加到发件箱文件（默认 `~/.dsh/wechat-bot/wechat-outbox.jsonl`） | 已实现 |
| 真正输入微信 | 可选 `--sender-config`；固定主窗或 `detachedWindow:true` 下使用已选独立窗口，数据库出站核对通过才返回微信消息 id | 测试账号与测试联系人的私聊模型回发已验证；测试群独立窗单条真实文字发送及数据库回执已验证；不消费旧发件箱 |
| 原生独立窗口 | 可选 `detachedWindow:true`，选择会话后双击打开或复用窗口，并把发送路由到已准备的目标独立窗口 | 单活动会话已接通；不包含多会话并行发送调度 |
| 窗口显隐 | 可选 | `desktopControl:true` 接通插件预留的 `window/get|set`，显示专用桌面及返回按钮 |

## 能读出什么

| 协议字段 | 来源 |
| --- | --- |
| `id` | `server_id`（全局唯一、重启不变）；为 0 时用 `分片名:local_id` |
| `sender.id` | `real_sender_id` → **本分片**的 `Name2Id` → wxid（主键，改名不变）；群消息正文前的 `wxid:\n` 前缀会剥掉 |
| `sender.name` / `aliases` | 都挂在 wxid 上：`name` = 群昵称 > 小号给 TA 的备注 > 昵称；`aliases` = 其余叫法 + 微信号（`contact.alias`）。名字缓存 10 秒，`chats/members` 每次都重新读，所以改名后最多 10 秒消息里就是新名字，`/attack 新名字` 立即可用 |
| 群昵称 | `contact.db` 的 `chat_room.ext_buffer`（protobuf `ChatRoomData`：成员 = wxid + 群昵称）。**这个格式按开源 4.x 读库工具的解析实现，没在真实库上核对过**；读不出来时不报错，退回备注/昵称 |
| `mentions` | `source` 列（`<msgsource><atuserlist>`，可能 zstd 压缩）；`notify@all` → `all`。**不从正文猜** |
| `quote` | 引用消息（`local_type = 57<<32 \| 49` 的 appmsg）里的 `<refermsg>`：被引用消息的 `svrid`、发送者、内容 |
| `kind` | 1 文字、3 图片、34 语音、43 视频、47/11000 表情、49 链接/文件、10000 系统消息；4.x 的复合类型码取低 32 位 |
| `text` | 文字消息正文（zstd 自动解压）；引用消息取回复正文；链接取标题 |
| `media` | 表情：`{mime, description}`（`<emoji desc>` 有就带上）；图片：`{mime}` |
| `fromSelf` | 发送者是小号自己 |

聊天列表：contact 里有消息表的群和私聊（排除公众号 `gh_*`、文件传输助手等系统号），群带成员数。群成员：`chat_room` + `chatroom_member`。

## 运行

以下账号、群名、消息标识及路径都是占位示例，部署时替换为本地配置；真实聊天与验收证据不随仓库分发。

```bash
pip install -r requirements.txt
python -u main.py                                    # 自动选 ~/Documents/xwechat_files 下最近活跃的账号
python -u main.py --account wxid_example_abcd        # 指定账号目录（示例）
python -u main.py --plain path/to/db_storage --self wxid_example   # 读未加密的库（测试/已解密的数据）
```

| 参数 | 说明 |
| --- | --- |
| `--data-root` | 微信数据根目录，默认 `~/Documents/xwechat_files` |
| `--account` | 账号目录名（示例 `wxid_example_abcd`）；不填选最近有消息写入的那个 |
| `--self` | 小号 wxid；不填从账号目录名去掉 `_xxxx` 后缀得到 |
| `--keys` | 当前账号专用的数据库密钥缓存文件；必须已存在且覆盖当前 contact/message 数据库 |
| `--outbox` | 发件箱 JSON Lines 路径 |
| `--sender-config` | 可选的旧隐藏桌面发送配置（下节）；启用真实文字发送，与 `--outbox` 互斥 |
| `--poll-ms` | 轮询间隔，默认 1000 |
| `--names` | JSON 文件 `{ "群id": "显示名" }`，覆盖微信里的群名/备注 |

在 DSH 插件里使用（`cordis.patch.yml`）：

真实多账号环境应显式指定相互匹配的 `--account`、`--self` 与该账号已有的 `--keys`，不要依赖最近活跃账号推断。`--self` 可覆盖目录推导身份，部署者必须核对二者及sender配置的botWxid一致；本次正式实例已按此配置并验证。

```yaml
- id: wechat-bot
  config:
    adapter:
      command: C:/path/to/python.exe
      args: [-u, C:/path/to/dsh-wechat-bot/adapters/wechat-db/main.py, --account, wxid_example_abcd]
```

## 加密与密钥

微信 4.x 的库是 SQLCipher 加密的。解密由 `vendor/db.py`（来自 wechatauto 项目，保留原许可证，未修改）完成，适配层 `ScopedWeChatDB` 只允许指定账号目录中的 `contact/contact.db` 和 `message/message_N.db`，并严格使用该账号的已有 `--keys` 缓存。缺少缓存、密钥不符或新分片缺少密钥都会明确失败，不扫描进程提取密钥，不写回密钥文件，也不尝试其他账号或其他缓存。

解密副本放在 `<dataDir>/wechat-db/cache/`，每次读取时增量合并 WAL，新消息一个轮询周期内可见。读不到库时适配器报告 `login_required` 并保留具体原因，后台每 5 秒重试。缓存库可读只证明数据库读取条件满足；真实登录与发送还须通过发送 worker 的账号/进程绑定验收。

## 发件箱格式

每行一条：

```json
{"id": "out:example-request:0", "clientId": "example-request:0", "chatId": "example-group@chatroom", "chatName": "测试群A",
 "content": {"kind": "text", "text": "示例消息", "mentions": []}, "createdAt": 1700000000000}
```

同一个 `clientId` 只写一次（重启后也不会重写）。`content` 与协议的 `message/send` 相同：`text` / `image{path}` / `sticker{path|stickerId}`。消费者负责按 `chatId` 把内容输入微信；输入成功后微信库里会出现这条消息，插件按正文把它认作回显，不会重复记录。

## 可选：内置 Windows 隐藏桌面文字发送

发送所需的 worker 源码已迁入 [native-runtime](native-runtime/README.md)，无需旧项目目录或旧版 JavaScript 插件。先按该目录说明安装 Windows Python 依赖，适配器通过子进程调用仓库内 worker 的 `probe/send/close`。仍须现场核对微信版本与控件门参数。`detachedWindow:true` 开启原生窗口准备。

配置 JSON 顶层：

```json
{
  "command": "C:/path/to/checkout/.venv/Scripts/pythonw.exe",
  "args": ["C:/path/to/checkout/adapters/wechat-db/native-runtime/python/worker.py"],
  "detachedWindow": true,
  "desktopControl": true,
  "worker": { "完整的 worker 配置": "见下文，不可直接使用本占位例子" }
}
```

`worker` 是旧运行配置中的 worker 对象，必须保留 `dbRoot/stateRoot/keyCacheFile`、`botWxid/botName`、`targetWxid/targetName/conversationType`、`expectedExe/expectedVersion`、`mainWindowClass/mainWindowTitle`、`gateModule/gateRva/gateTimeoutSeconds/gateExpectedOriginalByte/gateEnabledByte`，并且必须有 `desktopName`。新适配器拒绝默认桌面发送。账号必须与 `--self`（或 `--account` 推导值）相同。默认固定 `targetWxid`；`detachedWindow:true` 时列出本账号已有会话，由 `watch/set` 选择单一活动目标，发送只允许该目标。

在发送配置 JSON 顶层添加 `"detachedWindow": true` 后，控制台可搜索群聊或私聊，点击「选择此会话」会异步选中微信会话并双击打开原生独立窗口；已存在的同目标窗口复用。准备成功后，适配器保存该代窗口的类名、标题和 native worker 参数，后续发送使用该独立窗，不回退到主窗；准备期间暂缓发送，不移动默认桌面的鼠标或键盘焦点。原生发送器在独立窗 UIA 输入控件标签「输入」中写入并核对完整草稿，再触发「发送」，只有精确的数据库出站回执与控件门恢复都确认后才返回微信消息 id。接线没有增加额外的发送前整窗复核；既有账号/进程监视、焦点保护和控件门检查仍保留。该功能依赖 Windows、旧 worker 的只读账号校验及配套 wx4py 环境；不是新的窗口显隐协议。目前只支持单活动目标，不实现多会话并行调度。

`stateRoot` 和 `keyCacheFile` 应指向新实例专用状态目录，不与运行中的旧实例共享写入。实际版本、账号、目标群、桌面与控件门参数应现场核对，不能照抄文档示例或历史值；配置含本机身份和路径，应留在本地。**不要同时运行两个实例操作同一个微信窗口。**

新入群后，在控制台选择本账号的目标会话即可，不需要为每个群修改发送配置。初次绑定仍要求精确且唯一的主窗口；绑定后的 gate 和独立 watchdog 复核该 HWND 的所属进程、启动时间、版本、窗口属性及 DLL 身份，不再因另一个窗口临时同名而重新选择主窗口。窗口选择仍要求唯一目标、匹配抬头及空草稿；未在微信列表中物化的会话或重名目标会明确失败。

准备状态通过 `event/status.reason/detail` 显示在控制台。可恢复失败提供“重新准备”：只在上次 worker 正常关闭、gate 恢复及退出码 0 已确认后，显式重新选择同一会话才会开始下一次准备；准备中或已就绪的重复选择不重放操作。恢复未知时继续禁发，不能通过按钮或重复选择解封。

准备成功时还会发布内部 `preparedBinding` 快照。后续每条发送的 probe/verify 只核对原 PID、启动时间、可执行文件/版本、精确 HWND、DLL 和唯一账号目录及数据库句柄；DB 自号/昵称、精确目标联系人和群成员校验仍保留。绑定失效停发，不重新扫描或回退主窗。初次准备仍使用完整发现流程。只读现场对比：完整 probe 10.750 秒（全机扫描 9.906 秒），已绑定 probe 0.969 秒；此测量未发送消息。

`desktopControl:true` 仅允许与 `detachedWindow:true` 一起开启。它声明 `window` 能力，复用控制台已有显隐接口：显示时进入小号专用桌面，缺少小号进程时先启动登录窗口及“返回主桌面”工具栏；隐藏时返回 Default，保留小号进程。显示前必须确认返回工具栏就绪，不切换锁屏或无关桌面，不结束工作微信。后台发送不调用显隐控制；显示小号期间按既有桌面可用性约束暂缓发送。完成登录并返回后，可点“重新准备”重新绑定目标。窗口控制状态独立保存在 `worker.stateRoot/desktop-control`，进程按 PID、启动时间与可执行文件核验。

```bash
python -u main.py --account <账号目录> --sender-config <本地配置.json>
```

此模式只声明 `send: ["text"]`；图片、表情和非空 `mentions` 明确拒绝。调用前持久化并 `fsync` `<dataDir>/wechat-db/delivery.jsonl` 的 attempt，再进入旧发送器；只有精确出站回执和控件门恢复都通过才记为成功。已确认请求跨重启返回同一个微信 id；未完成或不确定的请求永不自动重发，后续不同 `clientId` 仅在 worker 正常关闭并确认恢复后继续。复用同一个 `clientId` 却更改账号、聊天或内容会报错。

锁屏等桌面不可用时返回 `unavailable`，持续推送 `canSend:false`，恢复后推送 `true`，不影响读库和模型生成。worker 清理无法确认，或适配器异常退出留下未完成 attempt 时，会跨重启禁发新消息；需要先人工核对控件门和进程恢复，本版本没有自动解封入口。已经正常关闭 worker 的不确定结果只禁止重发那一条，不阻断其他新消息。发送日志有独占文件锁，第二个适配器不能同时使用；日志损坏会拒绝启动，保留原文件进行对账，**不要删除日志后重试**。正常 shutdown 或宿主 stdin 关闭时走旧 worker 的正常 close，不调用 force_close 或强杀。

默认 outbox 与此模式是两条独立路径；已有发件箱不会被补发。下节记录当前版本的真实加密库与文字发送结果；锁屏及焦点变化仍需专项验证，离线测试不证明这些已通过。宿主若在发送中强行结束适配器，旧 worker 的清理仍依赖其 EOF 收尾与独立控件门 watchdog；该真实异常停机回收路径尚未验收，新适配器重启会因未完成 attempt 禁发，不能把它视为已自动恢复。

### 2026-10-22 测试群独立窗口发送验收

先使用独立验证适配器，通过选中的测试群独立窗口完成一条测试文字发送。准备状态从 `canSend:false` 转为 `true`，随后打开目标微信独立窗口；返回的 messageId 与数据库中的出站记录匹配，目标群、本人发送者和 `fromSelf:true` 均已核对，适配器以退出码 0 收尾。原始回执与数据库证明保存在部署者的私有验收目录，不随仓库分发。本次没有补发此前失败的请求。

随后加载正式插件，新发 `/help` 的收件和帮助回复均经数据库复核，正文哈希与生产发送日志一致。真实模型 `/ask` 后续分三段发送，三段逐条核对数据库目标、本人身份与正文哈希，生产journal全部confirmed；最终状态为 idle、backlog 0、模型/发送/内部错误均0。Python 测试 **134 passed**，Node 数据库→插件→发件箱端到端 **1 passed**；Node其余回归见项目README。群长期稳定性、多会话并行、媒体与锁屏仍须分别验收。

## 测试

当前适配器 **190 passed**，迁入 worker **90 passed**；Node 最新结果见根 README。覆盖已绑定 HWND 遇到额外同名窗、身份漂移拒绝、准备失败及安全重试、显隐协议与返回工具栏前置条件。真实新群通过 `/help` 与模型文字回发；2026-10-23 通过插件显示登录窗口、用户完成登录并返回后，测试群重新准备成功，迁入 worker 的两段模型回复均以数据库目标、本人和正文哈希确认。此前额外关闭空窗后新建的辅助验证未完成，不计为成功。

```bash
pip install -r requirements-dev.txt
python -m pytest tests                     # 读取层 + 子进程协议测试（用与微信 4.x 同结构的测试库）
node ../../plugins/dsh-wechat-bot/bin/check-adapter.js -- python -u main.py --plain <db_storage> --self wxid_example
```

插件侧还有一个端到端测试（数据库新消息 → 插件 → 模型 → 发件箱）：
`WECHAT_DB_PYTHON=<python> node --test plugins/dsh-wechat-bot/test/wechat-db.test.js`。

**验证边界**：测试账号真实加密库、与测试联系人私聊的模型回发、测试群文字收件、`/help`、真实模型三段回复及其数据库回执已通过。群长期稳定性、媒体、锁屏恢复、异常停机回收和多会话并行仍需分别验收。
