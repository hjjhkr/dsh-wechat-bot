# wechat-db 适配器

按 [适配器协议 v1](../../docs/protocol.md) 工作的微信适配器：**收消息读微信本地数据库，发消息只输出内容 JSON**。

| 方向 | 做法 | 状态 |
| --- | --- | --- |
| 收 | 轮询 `db_storage/message/message_N.db` 里所服务群的 `Msg_<md5>` 表，解析成协议消息推给插件 | 已实现；在同结构测试库上验证，**真实库待登录小号后验证** |
| 发 | 把要发的内容写成一行 JSON，追加到发件箱文件（默认 `~/.dsh/wechat-bot/wechat-outbox.jsonl`） | 已实现 |
| 把发件箱里的 JSON 真正输入微信 | — | **未实现，不在本适配器范围内** |
| 窗口显隐 | — | **未实现**（不声明 `window` 能力，控制台不显示开关） |

## 能读出什么

| 协议字段 | 来源 |
| --- | --- |
| `id` | `server_id`（全局唯一、重启不变）；为 0 时用 `分片名:local_id` |
| `sender.id` / `sender.name` | `real_sender_id` → **本分片**的 `Name2Id` → wxid；名字取 contact 的备注，其次昵称；群消息正文前的 `wxid:\n` 前缀会剥掉 |
| `mentions` | `source` 列（`<msgsource><atuserlist>`，可能 zstd 压缩）；`notify@all` → `all`。**不从正文猜** |
| `quote` | 引用消息（`local_type = 57<<32 \| 49` 的 appmsg）里的 `<refermsg>`：被引用消息的 `svrid`、发送者、内容 |
| `kind` | 1 文字、3 图片、34 语音、43 视频、47/11000 表情、49 链接/文件、10000 系统消息；4.x 的复合类型码取低 32 位 |
| `text` | 文字消息正文（zstd 自动解压）；引用消息取回复正文；链接取标题 |
| `media` | 表情：`{mime, description}`（`<emoji desc>` 有就带上）；图片：`{mime}` |
| `fromSelf` | 发送者是小号自己 |

聊天列表：contact 里有消息表的群和私聊（排除公众号 `gh_*`、文件传输助手等系统号），群带成员数。群成员：`chat_room` + `chatroom_member`。

## 运行

```bash
pip install -r requirements.txt
python -u main.py                                    # 自动选 ~/Documents/xwechat_files 下最近活跃的账号
python -u main.py --account wxid_xxx_c53e            # 指定账号目录
python -u main.py --plain path/to/db_storage --self wxid_bot   # 读未加密的库（测试/已解密的数据）
```

| 参数 | 说明 |
| --- | --- |
| `--data-root` | 微信数据根目录，默认 `~/Documents/xwechat_files` |
| `--account` | 账号目录名（如 `wxid_xxx_c53e`）；不填选最近有消息写入的那个 |
| `--self` | 小号 wxid；不填从账号目录名去掉 `_xxxx` 后缀得到 |
| `--keys` | 数据库密钥缓存文件 |
| `--outbox` | 发件箱 JSON Lines 路径 |
| `--poll-ms` | 轮询间隔，默认 1000 |
| `--names` | JSON 文件 `{ "群id": "显示名" }`，覆盖微信里的群名/备注 |

在 DSH 插件里使用（`cordis.patch.yml`）：

```yaml
- id: wechat-bot
  config:
    adapter:
      command: C:/Python313/python.exe
      args: [-u, C:/path/to/dsh-wechat-bot/adapters/wechat-db/main.py, --account, wxid_xxx_c53e]
```

## 加密与密钥

微信 4.x 的库是 SQLCipher 加密的。解密由 `vendor/db.py`（来自 wechatauto 项目，保留原许可证，未修改）完成：首次需要**微信已登录且在运行**，从微信进程里读出各个库的密钥，之后缓存在 `--keys` 指定的文件里，解密副本放在 `<dataDir>/wechat-db/cache/`，每次读取时增量合并 WAL，新消息一个轮询周期内可见。读不到库时适配器报告 `login_required`，后台每 5 秒重试，登录后自动接上。

## 发件箱格式

每行一条：

```json
{"id": "out:3fa1…:0", "clientId": "3fa1…:0", "chatId": "123@chatroom", "chatName": "测试群",
 "content": {"kind": "text", "text": "草", "mentions": []}, "createdAt": 1792604561772}
```

同一个 `clientId` 只写一次（重启后也不会重写）。`content` 与协议的 `message/send` 相同：`text` / `image{path}` / `sticker{path|stickerId}`。消费者负责按 `chatId` 把内容输入微信；输入成功后微信库里会出现这条消息，插件按正文把它认作回显，不会重复记录。

## 测试

```bash
pip install -r requirements-dev.txt
python -m pytest tests                     # 读取层 + 子进程协议测试（用与微信 4.x 同结构的测试库）
node ../../plugins/dsh-wechat-bot/bin/check-adapter.js -- python -u main.py --plain <db_storage> --self wxid_bot
```

插件侧还有一个端到端测试（数据库新消息 → 插件 → 模型 → 发件箱）：
`WECHAT_DB_PYTHON=<python> node --test plugins/dsh-wechat-bot/test/wechat-db.test.js`。

**尚未做的验证**：在真实账号的加密库上跑一遍（需要小号登录）。表结构来自 vendored `db.py` 对微信 4.x 的实测，测试库按同样的结构生成；真实库字段若有出入，需要在 `reader.py` 里调整。
