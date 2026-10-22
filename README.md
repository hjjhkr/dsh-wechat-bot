# dsh-wechat-bot

让一个微信小号像普通群友一样在**一个群**里聊天的 [DeepSeek Harness（DSH）](https://github.com/anywhere-labs/deepseek-harness-desktop) 插件。

> **当前状态（2026-10-22 实测）**
> - ✅ 初号机真实加密库、与浪味仙私聊的真实入站、真实模型生成及微信回发已通过。
> - ✅ △ 群已通过会话选择、双击打开独立窗口、按选中窗口走 native 文字发送，并以精确数据库回执确认一条真实发送。正式 `/help` 的数据库记录为 incoming `4576749726552072719`、outgoing `126267775936878936`。
> - ✅ 正式 `/ask` 使用真实模型生成三段且三段都已确认发送；结束时 backlog 为 0，`modelErrors`、`sendErrors` 均为 0。
> - ℹ️ 默认发送方式仍是写入 JSON 发件箱；只有显式提供本机 `--sender-config` 才启用同步真实文字发送。该路径依赖旧 `dsh-wechat-bridge`/wx4py 隐藏桌面 worker，且微信版本、Weixin.dll 与控件门参数必须和本机配置匹配；其他版本未验收。
> - ⏳ 当前只验收单活动目标；多会话并行、群聊长期稳定性、锁屏发送恢复、媒体收发/识别及窗口显隐尚未验收。

## 能做什么

- **合并连发的消息**：2 秒内连发的几条合成一批，以 JSON 数组一次交给模型。回复只针对思考开始时已有的消息；思考期间新来的消息成为下一批，不会反复重想。
- **判断在跟谁说话**：程序先根据 **@、引用、叫名字、刚聊完接着说** 算出每条消息的 `addressed`（you / maybe / other / none）和依据，再交给模型判断；有人直接找它却不回，会纠正一次。交给模型的消息**按人分组**（阿离：1、2、3；老鲍：1、2），每人的长期记忆放在自己的组里，另附时间顺序，模型不必从交错的消息里分辨谁说了什么。
- **定向互动**：`/attack 昵称` 持续嘲讽某人、`/comfort 昵称` 持续安慰某人，主动开场后 **TA 说一句才回一句**，TA 不说话就不发，其他人一律不理；`/unattack` `/uncomfort` 停止，TA 一小时不说话自动结束。
- **三种发言模式**（可用命令随时切换）：`free` 每批都给模型自由接话；`infer`（默认）像是在跟它说话才给模型；`at` 只回 @ 和引用；另有 `silent` 静音。
- **命令即时执行、插队**：`/` 命令在插件运行时里直接执行，不经过模型；回复插到所有排队消息前面立即发出；改变状态的命令（切模式、禁言、忘记、清上下文、`/ask`）会打断正在思考的旧回答，旧批次按新状态重新处理。
- **模型与思考强度可调**：`/model` 切换模型、`/think off|low|high|max` 调思考强度，切换前按 DSH 的模型目录校验，重启后保持。
- **定时消息**：`/cron 10m 内容`、`/cron 10:00 内容`、`/cron 每天 22:00 UTC-5 内容`……本地定时库，重启不丢。
- **身份认 wxid，名字跟着最新的走**：群昵称、昵称、备注、微信号都映射到 wxid 上；改名后按新名字也能找到同一个人，记忆和互动不受影响。
- **记得住人**：从聊天里主动积累每个成员的背景和偏好，按微信 id 归属，`/memory` 查看、`/forget` 删除。
- **扛得住、能自愈**：积压上限、限速、模型超时、连续失败熔断、看门狗、适配器崩溃自动重启；有压力与混沌测试。
- **收消息与处理不依赖桌面窗口**：适配器从本地数据库读取，插件按状态处理；可选真实发送后端需要可用的微信桌面窗口，锁屏发送恢复尚未验收。
- **在 DSH 里看得见**：右侧栏控制台（连接、群、模式、日志、健康指标）；工作区里的「微信 · 群名」会话实时显示模型收到了什么、输出了什么；`/wechat eval` 用真实模型评测"该不该说话、在跟谁说"。

**原则：说不说由脚本决定，说什么由模型决定。** 对象判断、发言模式、目标识别（按数据库里的发送者 id）、定向互动的触发、记忆归属、限速熔断都是确定的程序逻辑，可测试、不会被模型"理解错"；模型只负责措辞和是否在可选场合接话。

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
    engagement.js              /attack /comfort：按昵称或 @ 找人（脚本完成，不交给模型）
    models.js                  /model /think：模型与思考强度切换（按 DSH 模型目录校验）
    guard.js                   限速、熔断、超时、发送优先通道
    protocol.js rpc.js adapter.js simulator.js   适配器协议、传输、模拟器
    store.js eval.js
  client/index.js              右侧栏控制台
  bin/simulator.js  bin/check-adapter.js
  personas/  test/
adapters/wechat-db/            微信数据库适配器（Python）：读库收消息；默认发件箱，可选旧 worker 真实文字发送
  main.py                       参数入口（含可选 --sender-config）
  wechat_db/source.py           加密库范围约束与读取
  wechat_db/adapter.py          协议、监听及 outbox/delivery 分流
  wechat_db/delivery.py         可选同步发送的持久防重与回执
  wechat_db/legacy_sender.py    旧 worker 子进程及会话目标选择
  wechat_db/detached_window.py 双击打开/复用目标独立窗口
  wechat_db/native_window_worker.py 隐藏桌面窗口准备、验证与派发
  wechat_db/native_send.py      选中窗口的文字发送和数据库回执
docs/                          protocol.md 协议 · commands.md 命令 · handoff.md 交接与对比
```

## 安装

### DSH Web（本轮验证过的安装流程）

1. 克隆仓库，并启动使用独立 `DSH_HOME` 的 DSH Web 实例。
2. 将插件链接到 Web profile：`dsh plugin --profile web add link:<插件绝对路径>`。插件的 Host peer dependencies 由 DSH 运行时提供；不要把其他实例的 `node_modules` 链接进源码目录。
3. 在工作区会话输入 **`/wechat`**，按提示完成初始化，再在控制台「选择会话」中选择目标群或私聊。

### DSH Desktop（保留的旧说明，本轮未验证）

DSH Desktop ≥ 2.0（运行时 0.2.1-rc.2）可在 **设置 → 插件 → 添加插件** 中选择 `…\dsh-wechat-bot\plugins\dsh-wechat-bot`，或使用 `dsh plugin --profile desktop add link:<该目录>`；重启后在工作区会话输入 **`/wechat`**。本轮真实微信验收是在 DSH Web 工作区完成的，没有逐项重验 Desktop 流程。

独立 Web 实例使用 `web` profile；npm CLI 的 `desktop` profile 属于 Electron 专用，不用于独立 Web 实例。

不配置适配器时插件连接内置**模拟器**（假群聊，控制台里可以模拟群友发言），可以完整试用。接真实微信：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml（Desktop使用desktop目录）
- id: wechat-bot
  config:
    adapter:
      command: C:/Python313/python.exe
      args: [-u, C:/path/to/dsh-wechat-bot/adapters/wechat-db/main.py, --account, wxid_xxx_c53e]
```

以上示例使用默认发件箱。需要启用可选真实文字发送时，才在参数中增加 `--sender-config <本机配置文件路径>`；它与显式 `--outbox` 互斥，且只开放文字发送。账号目录、密钥缓存、旧 worker 路径和控件门配置都属于本机私有配置，不要写入仓库。适配器参数、配置结构和故障处理见 [adapters/wechat-db/README.md](adapters/wechat-db/README.md)。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `adapter.command` / `args` / `cwd` / `env` | 空 = 模拟器 | 适配器进程 |
| `model.provider` / `model` | 空 = DSH 默认模型 | |
| `model.reasoningEffort` | `off` | 思考强度 off/low/high/max；`/ask` 临时用 high；运行中可用 `/model` `/think` 覆盖 |
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
            ▼                         ├ /cron：写入本地定时库，到点按原文发送
            │                         └ /attack /comfort：脚本按 @/昵称定目标，模型写开场白
   定向互动中？ ─是→ 只留目标（按发送者 id）的消息；没有就跳过；一批只回一次
            ▼
   合批（2s 静默 / 8s 上限 / 最多 20 条，溢出转上下文）
            ▼
   对象判断 addressed + 依据 → 模式过滤（free / infer / at / silent）
            ▼
   限速 · 熔断 → 模型（硬超时；同时镜像到「微信 · 群名」会话）
            ▼
   {"to": 消息id, "reply": ["短句", …], "memory": [...]}
     不合格→纠正一次；有人找它却沉默→提醒一次
            ▼
    记忆写入（证据须来自本批且属于该成员）→ 发送通道（按 canSend 等待；过时丢弃）
            ▼
    adapter.message/send
      ├ 默认：wechat-db 写一行内容 JSON 到发件箱
      └ 配置 --sender-config：旧隐藏桌面 worker 在选中的主窗/独立窗发送文字，以精确数据库回执确认
```

## 测试

```bash
cd plugins/dsh-wechat-bot
node --test test/*.test.js                  # 独立检出需要 DSH Host 依赖；见下方本轮实测说明
STRESS_SCALE=3 node --test test/stress.test.js
cd ../../adapters/wechat-db && python -m pytest tests     # 当前全套 134 项
```

2026-10-22 实测：Python 适配器全套 **134 passed**；Node 数据库→插件→默认发件箱定向端到端 **1 passed**。Node 全量测试在当前源码检出直接运行时 **91 passed，另有 `dsh.test.js` 因缺少 `@deepseek-ai/cordis` 等 DSH Host 依赖而失败**；随后用只读解析现有 DSH Web Host 依赖的临时 Node hook 单独运行 `dsh.test.js`，**5 passed**。96 项覆盖来自两次运行，不是原始全量命令一次干净通过。

| 测试文件 | 覆盖 |
| --- | --- |
| `units` `protocol` | 合批、对象判断、输出解析、记忆归属、协议与 stdio 传输、崩溃与进程回收 |
| `bot` | 合批到模型、纠正、插话/沉默、思考中新消息进下一批、多条回复、`canSend` 等待、发送失败语义、重启恢复 |
| `commands` | 四种模式各自放行哪些消息、命令插队、打断旧回答、`/ask` 越过限速、刷命令限流 |
| `models` | 模型/思考强度切换的校验、持久化、`/ask` 降级、聊天里的 `/model` `/think` |
| `engagement` | 找人（@ 优先、精确、唯一模糊、重名/找不到/自己）、按人分组的模型输入、开场、只回目标、一批一回、目标沉默不发、替换与停止、禁言暂停、超时结束、重启保持、必须回复 |
| `cron` | 时间解析（相对、钟点、日期、每天、时区、DST）、非法输入、定时库限额与只取一次、到点发送、重启补发/错过、不执行命令、锁屏 |
| `stress` | 50 人刷屏、混乱模型、适配器崩溃风暴、发送故障+锁屏抖动、看门狗、长时间运行 |
| `dsh` | 用 DSH 真实会话服务验证「微信 · 群名」会话的流式、失败、取消、崩溃恢复 |
| `wechat-db` | 数据库新消息 → 适配器 → 插件 → 模型 → 默认发件箱 JSON |
| `adapters/wechat-db/tests` | 解析（分片、发送者映射、群昵称/改名/微信号映射到 wxid、zstd、@、引用、表情、图片、系统消息）、子进程协议、发件箱/同步发送幂等、默认/独立窗口 worker 桥接、读不到库时的恢复 |

## 许可

MIT。人设改编自 [mtshang/make-your-qq-ai-group-member](https://github.com/mtshang/make-your-qq-ai-group-member)（MIT）。`adapters/wechat-db/vendor/` 下的第三方代码保留原许可证。
