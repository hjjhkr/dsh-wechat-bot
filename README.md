# dsh-wechat-bot

让一个微信小号像普通群友一样在群里聊天的 [DeepSeek Harness（DSH）](https://github.com/anywhere-labs/deepseek-harness-desktop) 插件。

- **自然地聊**：一阵连发的消息合并成一批，一次交给模型；模型自己判断要不要接话、在回谁，可以一次发几条短消息。
- **知道别人在跟谁说话**：@、引用、叫名字、私聊、"刚聊完接着说"这些信号由程序算好，作为事实交给模型（见[对象判断](#说话对象判断)）。
- **记得住人**：从日常聊天里主动积累每个成员的背景和偏好，只按微信 id 归属，别人改不了、冒充不了。
- **聊天命令**：`/mode`、`/mute`、`/ask`、`/tldr`、`/memory`… 也能自己写命令脚本（[docs/commands.md](docs/commands.md)）。
- **在 DSH 里看得见**：右侧栏控制台显示连接状态、监听的聊天、每个聊天的处理日志；每个聊天在工作区里有一个"微信 · 聊天名"会话，实时显示模型收到了什么、输出了什么。
- **锁屏也工作**：插件侧不依赖桌面，锁屏时照常收消息、思考；发不出去就排队，解锁后发，过时的回复自动丢弃。
- **和微信解耦**：插件只说一份 [JSON-RPC 适配器协议](docs/protocol.md)。微信怎么读、怎么发由适配器负责，可以替换。自带一个协议完整的**模拟器**，不连微信也能完整体验和测试。

> 当前状态：插件逻辑、DSH 集成、协议、模拟器、测试均已完成；**真实微信适配器尚未按新协议实现**（交接说明见 [docs/handoff.md](docs/handoff.md)）。

## 目录

```
plugins/dsh-wechat-bot/        DSH 插件（安装的就是这个目录）
  lib/
    index.js                   插件入口与配置 schema
    app.js                     WeChatBotApp：控制台、/wechat、agent 工具共用的一组操作
    surface.js                 DSH 接口层：HTTP 路由、/wechat 命令、wechat_bot 工具
    session.js                 每个聊天一个原生 DSH 会话，镜像模型调用
    model.js                   通过 DSH llm 服务调用模型
    bot.js                     适配器连接、自动重连、聊天监听管理
    chat.js                    单个聊天的流水线：合批 → 判断 → 回复 → 发送
    batcher.js addressing.js prompt.js decision.js memory.js commands.js eval.js store.js
    protocol.js rpc.js adapter.js   协议定义、JSON-RPC 传输、插件侧客户端
    simulator.js               模拟器适配器
  client/index.js              右侧栏控制台（React，DSH 主题变量）
  bin/simulator.js             模拟器的 stdio 入口
  bin/check-adapter.js         适配器一致性检查工具
  personas/                    默认人设（MIT，来源见 source.json）
  test/                        node:test 测试
adapters/wechat-windows/       旧版 Windows 微信读写代码（未改动，等待按新协议重写）
docs/                          协议、命令、交接文档
```

## 安装到 DSH Desktop

需要 DSH Desktop ≥ 2.0（DSH 运行时 0.2.1-rc.2）。

1. 克隆仓库。
2. 在 DSH 里打开 **设置 → 插件 → 添加插件**，填入插件目录的绝对路径，例如
   `C:\path\to\dsh-wechat-bot\plugins\dsh-wechat-bot`。
   命令行也可以：`dsh plugin --profile desktop add link:C:/path/to/dsh-wechat-bot/plugins/dsh-wechat-bot`
3. 重启 DSH Desktop。

### 第一次使用

1. 在你想放控制台的工作区里开一个会话，输入 **`/wechat`**（或者跟 DSH 说"帮我初始化微信机器人"，它会调用 `wechat_bot` 工具）。
2. 插件绑定这个工作区，并让适配器准备小号登录，告诉你该做什么（真实适配器：在手机上确认小号登录；模拟器：自动完成）。
3. 登录好后再输入一次 `/wechat`（或告诉 DSH"好了"），初始化完成，右侧栏会自动打开 **微信机器人** 控制台。
4. 在控制台点 **选择聊天**，勾选要监听的群/私聊。
5. 之后在这个工作区的 **微信 · 聊天名** 会话里随时看模型在想什么。

`/wechat status` 查看状态；`/wechat eval off high` 用真实模型跑内置评测，对比思考强度。

### 配置

在 DSH 的插件设置里改，或写进 `~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- id: wechat-bot
  config:
    adapter:
      command: C:/Python312/python.exe        # 空 = 内置模拟器
      args: [-u, C:/path/to/adapters/wechat-windows/adapter.py]
    owner: { id: wxid_xxxxxxxx, name: 主人 }    # 只认 id
    admins: []
    aliases: [小鲸鱼, DeepSeek]                # 除微信昵称外，大家怎么叫它
    model:
      provider: ''                             # 空 = DSH 默认模型
      model: ''
      reasoningEffort: 'off'                   # off | low | high | max
      maxTokens: 600
    behavior:
      mode: free                               # free | mention | silent
      quietMs: 2000                            # 2 秒没有新消息就合批
      maxWaitMs: 8000                          # 一批最多等 8 秒
      maxParts: 3                              # 一次最多发几条
      idleMinutes: 0                           # 群冷场多少分钟后可以主动说话，0 = 不主动
      staleMinutes: 10                         # 发不出去的回复多久后丢弃
    stickers: {}                               # 表情包：名字 → 图片路径，模型可以发
    commandsDir: ''                            # 自定义命令脚本目录
    personaPath: ''                            # 空 = 自带人设
```

完整 schema 见 [`lib/index.js`](plugins/dsh-wechat-bot/lib/index.js)。状态存放在 `~/.dsh/wechat-bot/`。

## 工作原理

```
微信 ──(适配器进程)── JSON-RPC over stdio ──┐
                                            ▼
                     Bot ── 每个聊天一个 ChatRunner
                                │
         消息 ─▶ / 命令？──是──▶ 命令运行时（直接回复，或带指令转给模型）
                  │否
                  ▼
           Batcher：2 秒静默 / 8 秒上限，把连发的消息合成一批
                  │
           模式 / 禁言过滤（mention 模式没人找它就不调模型）
                  │
           addressing：给每条消息算出 addressed = you / maybe / other / none
                  │
           prompt：人设 + 平台规则 + JSON 输入（recent 上下文 / new 新消息 / memory）
                  │
           DSH llm ──（同时镜像到 "微信 · 聊天名" 会话）
                  │
           decision：{"to": 消息id, "reply": ["短句", …], "memory": [...]}
                  │      输出不合法 → 带原因纠正一次；有人直接找它却沉默 → 提醒一次
                  │      思考期间又来了新消息 → 丢掉旧回答，连同新消息重新考虑（有上限）
                  ▼
           记忆写入（证据必须来自本批、且属于该发送者）→ 逐条发送（模拟打字间隔）
```

### 消息合并

同一个聊天里，消息先进 `Batcher`：2 秒内没有新消息、或从第一条起满 8 秒、或攒够 20 条 / 6000 字，就合成一批，**一次**交给模型。模型收到的 `new` 是这一批的数组，之前处理过的进 `recent`。模型思考期间来的消息会让这次回答作废并和新消息一起重新考虑，避免"答非所问"。

### 说话对象判断

只靠模型"读空气"很不稳定，所以程序先算出确定的事实，模型再做最终判断：

| addressed | 依据 |
| --- | --- |
| `you` | 私聊；`@` 了小号；引用了小号的话；用名字/别名称呼它（"小鲸鱼，…"、"…你说呢 小鲸鱼"）；用 `/ask` 等命令点名 |
| `other` | `@` 了别人；引用了别人的话 |
| `maybe` | 句中顺口提到它的名字；刚被它回复过的人 3 分钟内接着说 |
| `none` | 普通群聊 |

有 `you` 时模型必须回复（沉默会被纠正一次）；`other` 默认不插嘴；`mention` 模式下没有 `you` 根本不调用模型。模型还要输出 `to`（回应哪条消息），控制台日志和评测会检查它。

**思考强度能不能解决？** 不能代替上面这些信号——"谁 @ 了谁、引用了谁"是元数据，模型猜得再认真也不如直接告诉它。思考强度能改善"该不该接一般闲聊"这类主观判断，代价是延迟。现在的做法：默认 `off`（快、像真人），`/ask` 时临时用 `high`；`/wechat eval off high` 会用内置的 12 个场景实测两种强度的通过率和平均耗时，你可以按结果调 `model.reasoningEffort`。

## 开发

```bash
cd plugins/dsh-wechat-bot
# 测试依赖 DSH 自带的 @deepseek-ai/* 包：把 node_modules 指向 DSH Desktop 的模块目录（只用于开发，已 gitignore）
mklink /J node_modules "%LOCALAPPDATA%\Programs\DSH Desktop\resources\app\node_modules"
node --test test/*.test.js          # 用 DSH 自带的 Node 24 也可以
node bin/simulator.js --logged-in   # 单独运行模拟器（stdio）
node bin/check-adapter.js -- node bin/simulator.js --logged-in
```

测试覆盖：协议与 stdio 传输、合批、对象判断、输出解析、记忆归属、命令、模式、锁屏等待与过时丢弃、发送重试语义、断线重连、多聊天并发、重启恢复，以及用真实 DSH 会话服务验证的会话镜像（流式、失败、取消、崩溃恢复）。

## 路线图

- 按协议实现 Windows 微信 4.x 适配器（[交接说明](docs/handoff.md)）
- 窗口显隐（协议已定义 `window/get|set`，控制台开关已做好）
- 图片 / 表情包识别：协议已定义 `kind`、`media.description`、`media/fetch`；下一步把图片交给多模态模型
- 表情包发送：已支持 `stickers` 配置，模型可以输出 `{"sticker":"名字"}`；适配器需要实现 `sticker` 发送

## 许可

MIT。人设文件改编自 [mtshang/make-your-qq-ai-group-member](https://github.com/mtshang/make-your-qq-ai-group-member)（MIT）。`adapters/wechat-windows/vendor/` 下的第三方代码保留其原许可证。
