# dsh-wechat-bot

让一个微信小号像普通群友一样在**一个群**里聊天的 [DeepSeek Harness（DSH）](https://github.com/anywhere-labs/deepseek-harness-desktop) 插件。

> **当前状态（诚实版）**
> - ✅ 插件逻辑（合批、说话对象判断、三种发言模式、命令、定时、记忆、护栏与自愈）、DSH 集成、协议、测试：完成。
> - ✅ 收消息：读微信本地数据库的适配器已实现，在与微信 4.x 同结构的测试库上全链路验证通过。
> - ⏳ **还没在真实账号的加密库上跑过**（需要小号在这台电脑上登录后验证）。
> - ⏳ 发消息：插件只输出**内容 JSON**（写入发件箱文件）。**把 JSON 输入到微信里这一步没做**，交给后续实现。
> - ⏳ 小号窗口显隐切换：**没做**（协议里留了接口，控制台有开关，但没有适配器实现它）。
> - ⏳ 图片/表情包的内容识别和发送：协议和数据字段已留，**识别与发送没做**。

## 能做什么

- **合并连发的消息**：2 秒内连发的几条合成一批，以 JSON 数组一次交给模型。回复只针对思考开始时已有的消息；思考期间新来的消息成为下一批，不会反复重想。
- **判断在跟谁说话**：程序先根据 **@、引用、叫名字、刚聊完接着说** 算出每条消息的 `addressed`（you / maybe / other / none）和依据，再交给模型判断；有人直接找它却不回，会纠正一次。
- **三种发言模式**（可用命令随时切换）：`free` 每批都给模型自由接话；`infer`（默认）像是在跟它说话才给模型；`at` 只回 @ 和引用；另有 `silent` 静音。
- **命令即时执行、插队**：`/` 命令在插件运行时里直接执行，不经过模型；回复插到所有排队消息前面立即发出；改变状态的命令（切模式、禁言、忘记、清上下文、`/ask`）会打断正在思考的旧回答，旧批次按新状态重新处理。
- **定时消息**：`/cron 10m 内容`、`/cron 10:00 内容`、`/cron 每天 22:00 UTC-5 内容`……本地定时库，重启不丢。
- **记得住人**：从聊天里主动积累每个成员的背景和偏好，按微信 id 归属，`/memory` 查看、`/forget` 删除。
- **扛得住、能自愈**：积压上限、限速、模型超时、连续失败熔断、看门狗、适配器崩溃自动重启；有压力与混沌测试。
- **锁屏也工作**：插件不依赖桌面；发不出去就排队，过时丢弃。
- **在 DSH 里看得见**：右侧栏控制台（连接、群、模式、日志、健康指标）；工作区里的「微信 · 群名」会话实时显示模型收到了什么、输出了什么；`/wechat eval` 用真实模型评测"该不该说话、在跟谁说"。

完整命令见 [docs/commands.md](docs/commands.md)。和最初版本的对比见 [docs/handoff.md](docs/handoff.md)。

## 目录

```
plugins/dsh-wechat-bot/        DSH 插件（安装的就是这个目录）
  lib/
    index.js                   插件入口、配置 schema
    app.js  surface.js         DSH 集成：控制台 API、/wechat 命令、wechat_bot 工具
    session.js  model.js       「微信 · 群名」会话镜像、模型调用
    bot.js                     适配器连接与自动重启、所服务的群、看门狗
    chat.js                    一个群的流水线：命令 → 合批 → 模式 → 对象判断 → 模型 → 记忆 → 发送
    batcher.js addressing.js prompt.js decision.js memory.js
    commands.js cron.js        命令（含 /cron）
    guard.js                   限速、熔断、超时、发送优先通道
    protocol.js rpc.js adapter.js simulator.js   适配器协议、传输、模拟器
    store.js eval.js
  client/index.js              右侧栏控制台
  bin/simulator.js  bin/check-adapter.js
  personas/  test/
adapters/wechat-db/            微信数据库适配器（Python）：读库收消息，发消息写发件箱 JSON
docs/                          protocol.md 协议 · commands.md 命令 · handoff.md 交接与对比
```

## 安装

1. 克隆仓库。DSH Desktop ≥ 2.0（运行时 0.2.1-rc.2）。
2. DSH **设置 → 插件 → 添加插件**，填 `…\dsh-wechat-bot\plugins\dsh-wechat-bot`（或 `dsh plugin --profile desktop add link:<该目录>`），重启 DSH。
3. 在想放控制台的工作区开一个会话，输入 **`/wechat`**；按提示登录小号后再输入一次，完成初始化，右侧栏出现「微信机器人」控制台。
4. 控制台里 **选择群**。

不配置适配器时插件连接内置**模拟器**（假群聊，控制台里可以模拟群友发言），可以完整试用。接真实微信：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: wechat-bot
  config:
    adapter:
      command: C:/Python313/python.exe
      args: [-u, C:/path/to/dsh-wechat-bot/adapters/wechat-db/main.py, --account, wxid_xxx_c53e]
```

适配器的参数和发件箱格式见 [adapters/wechat-db/README.md](adapters/wechat-db/README.md)。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `adapter.command` / `args` / `cwd` / `env` | 空 = 模拟器 | 适配器进程 |
| `model.provider` / `model` | 空 = DSH 默认模型 | |
| `model.reasoningEffort` | `off` | 思考强度 off/low/high/max；`/ask` 临时用 high |
| `model.maxTokens` | 600 | |
| `aliases` | `[小鲸鱼, DeepSeek]` | 除微信昵称外大家怎么叫它（用于"叫名字"判断） |
| `behavior.mode` | `infer` | free / infer / at / silent |
| `behavior.quietMs` / `maxWaitMs` | 2000 / 8000 | 合批：静默多久 / 最多等多久 |
| `behavior.maxMessages` | 20 | 一批最多几条；排队超过的更早消息转为上下文 |
| `behavior.maxParts` | 3 | 一次最多发几条 |
| `behavior.idleMinutes` | 0 | 冷场多久后可以主动说话（仅 free 模式），0 = 不主动 |
| `behavior.staleMinutes` | 10 | 发不出去的回复多久后丢弃 |
| `behavior.cronZone` | `+08:00` | `/cron` 默认时区 |
| `guard.maxTurnsPerMinute` | 8 | 每分钟最多几次模型调用 |
| `guard.commandsPerMinute` | 6 | 每人每分钟最多几条命令 |
| `guard.modelTimeoutSeconds` | 90 | 单次模型调用超时 |
| `guard.maxTextChars` | 2000 | 超长消息截断 |
| `guard.breakerThreshold` / `breakerBaseSeconds` | 3 / 30 | 连续几次失败熔断 / 首次暂停多久（之后翻倍，最长 10 分钟） |
| `guard.stuckMinutes` | 5 | 处理卡住多久由看门狗重建 |
| `stickers` | `{}` | 表情包名 → 图片路径，模型可输出 `{"sticker":"名字"}` |
| `commandsDir` | 空 | 自定义命令脚本目录 |
| `personaPath` | 自带人设 | |
| `dataDir` | `~/.dsh/wechat-bot` | 状态目录 |

## 工作原理

```
微信本地数据库 ── adapters/wechat-db（轮询、解析）── JSON-RPC over stdio ──┐
                                                                             ▼
                                         Bot（适配器自动重启 · 看门狗）── ChatRunner（所服务的群）
   消息 → 以 / 开头？ ─是→ 命令运行时：立即执行 → 回复走优先通道插队发出
            │                         ├ 改状态的命令：打断正在思考的旧回答，旧批次按新状态重算
            │否                       ├ /ask /tldr：先回"收到"，插队交给模型（不受限速）
            ▼                         └ /cron：写入本地定时库，到点按原文发送
   合批（2s 静默 / 8s 上限 / 最多 20 条，溢出转上下文）
            ▼
   对象判断 addressed + 依据 → 模式过滤（free / infer / at / silent）
            ▼
   限速 · 熔断 → 模型（硬超时；同时镜像到「微信 · 群名」会话）
            ▼
   {"to": 消息id, "reply": ["短句", …], "memory": [...]}
     不合格→纠正一次；有人找它却沉默→提醒一次
            ▼
   记忆写入（证据须来自本批且属于该成员）→ 发送通道（打字节奏；锁屏等待；过时丢弃）
            ▼
   adapter.message/send ── wechat-db：写一行内容 JSON 到发件箱 ──（输入微信：未实现）
```

## 测试

```bash
cd plugins/dsh-wechat-bot
mklink /J node_modules "%LOCALAPPDATA%\Programs\DSH Desktop\resources\app\node_modules"   # 开发用，指向 DSH 自带模块
node --test test/*.test.js                  # 71 项（含压力/混沌；数据库端到端需 WECHAT_DB_PYTHON）
STRESS_SCALE=3 node --test test/stress.test.js
cd ../../adapters/wechat-db && python -m pytest tests     # 12 项
```

| 测试文件 | 覆盖 |
| --- | --- |
| `units` `protocol` | 合批、对象判断、输出解析、记忆归属、协议与 stdio 传输、崩溃与进程回收 |
| `bot` | 合批到模型、纠正、插话/沉默、思考中新消息进下一批、多条回复、锁屏、发送失败语义、重启恢复 |
| `commands` | 四种模式各自放行哪些消息、命令插队、打断旧回答、`/ask` 越过限速、刷命令限流 |
| `cron` | 时间解析（相对、钟点、日期、每天、时区、DST）、非法输入、定时库限额与只取一次、到点发送、重启补发/错过、不执行命令、锁屏 |
| `stress` | 50 人刷屏、混乱模型、适配器崩溃风暴、发送故障+锁屏抖动、看门狗、长时间运行 |
| `dsh` | 用 DSH 真实会话服务验证「微信 · 群名」会话的流式、失败、取消、崩溃恢复 |
| `wechat-db` | 数据库新消息 → 适配器 → 插件 → 模型 → 发件箱 JSON |
| `adapters/wechat-db/tests` | 解析（分片、发送者映射、zstd、@、引用、表情、图片、系统消息）、子进程协议、发件箱幂等、读不到库时的恢复 |

## 许可

MIT。人设改编自 [mtshang/make-your-qq-ai-group-member](https://github.com/mtshang/make-your-qq-ai-group-member)（MIT）。`adapters/wechat-db/vendor/` 下的第三方代码保留原许可证。
