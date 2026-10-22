# 交接说明

> 写给接手的人。先读这一份，再按需读 [protocol.md](protocol.md)（插件 ↔ 适配器协议）、[commands.md](commands.md)（聊天命令）和 [README](../README.md)。

## 1. 一句话现状

**插件、真实加密库和初号机↔浪味仙私聊的真实模型回复已通过；△群的已选独立窗发送路由已接通，并以精确数据库回执验证一条真实文字发送。当前单活动会话；多会话并行、△群新消息读取和媒体、锁屏恢复仍需另验。窗口显隐协议仍未实现。**

## 2. 和最初版本相比

最初版本 = 提交 `85a9ec3`（重构前的完整快照）。只列真正的改进；没做的放在第 3 节，不算改进。

### 更稳定

| | 最初版本 | 现在 |
| --- | --- | --- |
| 模型出错 | 纠正一次，失败则记 `model_failed`；没有超时、没有熔断 | 单次调用硬超时（下游不理会取消也能放弃）；连续失败熔断，冷却指数增长，自动试探恢复 |
| 刷屏 | 无积压上限，无调用频率限制 | 排队最多 20 条，更早的转为上下文；每分钟最多 N 次模型调用，多出的批次**等待并合并**而不是丢弃 |
| 处理卡死 | 无 | 看门狗发现思考/发送超时，用快照（上下文、记忆、模式、定时）重建处理流程 |
| 适配器/worker 崩溃 | 停下，等人工对账、确认后才能恢复 | 结束旧进程（不泄漏）、退避重启、自动重新检查登录和监听 |
| 发送结果不确定 | 停止整个监听，必须人工 acknowledge | 只记日志、不重试这一条，机器人继续工作；"确定失败"才退避重试 |
| 单条坏消息 | 可能中断处理 | 只记日志，不影响后续 |
| 锁屏 | 锁屏时暂停生成，解锁后再处理 | 锁屏时照常收消息、照常思考；只有发送等待，过时丢弃 |
| 状态写盘 | 每次写 | 合并写、按文件串行、Windows 下重试原子替换 |
| 验证方式 | 70+ 项测试，很多是针对单次事故的墓碑测试 | 重构交接基线：96 项场景测试（Node，含数据库端到端）+ 19 项（Python）；6 个压力/混沌场景（3 倍负载下：9000 条刷屏、模型随机报错/卡死/乱输出、12 次适配器崩溃、发送故障+锁屏抖动、看门狗、长时间写记忆），都断言不挂、有界、限速生效、风暴后能正常回复。2026-10-22 续做后的实际验证见第 7 节 |

### 功能做成了

| | 最初版本 | 现在 |
| --- | --- | --- |
| 多条消息合并给模型 | 有代码但**实际没生效** | 合批生效：一批 JSON 数组一次给模型；回复只针对思考开始时已有的消息，思考期间新来的进下一批（不反复重想，刷屏时也不会被拖住） |
| 判断在跟谁说话 | 模型从正文里猜，消息按时间交错排列，常分不清谁说了什么 | 程序先算 `addressed`（you/maybe/other/none）和依据（@、引用、叫名字、接话）再给模型；有人直接找它却沉默会纠正一次；只靠消息 id 的引用也能识别。输入**按人分组**（每人的消息和记忆在一起），另附时间顺序 |
| 定向互动 | 无 | `/attack` `/comfort`：脚本按 @ 或任一当前叫法（群昵称/昵称/备注/微信号）确定目标，只有目标（按 id）说话才触发，一批一回，目标沉默不发，别人不理；`/unattack` `/uncomfort` 或 1 小时无回应结束 |
| 发言模式 | 无 | `free` / `infer`（默认）/ `at` / `silent`，命令随时切换 |
| 命令 | 无 | 运行时直接执行；回复插队；改状态的命令打断正在思考的旧回答并按新状态重算；每人限流 |
| 定时消息 | 无 | `/cron`：相对/钟点/日期/每天、时区与夏令时、落盘、重启补发、绝不重发 |
| 一次多条短回复 | 一条 | 最多 N 条，按打字节奏发送 |
| 长期记忆 | 有，但规则复杂、满了直接失败 | 按成员 id 归属、证据必须属于该成员、敏感信息拒绝；满了淘汰最旧；`/memory` `/forget` |
| 模型工作可见 | 自建网页 + 待合并的会话补丁 | DSH 原生会话「微信 · 群名」实时流式显示输入和输出；控制台显示健康指标 |
| 模型与思考强度 | 固定 deepseek-flash、思考 off，改要改配置重启 | `/model` 切换模型、`/think` 调思考强度，按 DSH 模型目录校验、持久化；`/ask` 临时 high；`/wechat eval off high` 用 11 个内置场景实测对比 |
| 收消息 | 旧 worker：读库 + 隐藏桌面 + 内存控件门 + 焦点监测，一体耦合 | 独立的数据库适配器：只读库，解析发送者、@、引用、表情、图片、系统消息；不需要窗口、焦点和内存改写 |

### 更可扩展

| | 最初版本 | 现在 |
| --- | --- | --- |
| 结构 | `bridge.js` 1000+ 行包办一切，与特定 worker 的私有格式耦合 | 按职责拆分（合批、对象判断、模式、命令、定时、护栏、记忆、发送通道各自独立），核心逻辑不依赖 DSH，可单测 |
| 加功能 | 改核心代码 | 新命令：在 `commandsDir` 放一个脚本；新模式：`MODES` + `#skipReason` 一处；新护栏参数：配置项 |
| 换接入方式 | 改插件 | 实现协议即可；有模拟器和一致性检查工具可以独立验证 |

### 删掉了什么

隐藏桌面、焦点租约与监测、Weixin.dll 内存控件门、两步发送授权勾选、人工对账/acknowledge 接口、单聊天切换回滚、"主人"身份等。它们要么属于"怎么操作微信界面"（不在插件里做），要么是为单次事故打的补丁。旧代码都在 `85a9ec3` 里可查。

## 3. 未完成的工作（诚实列出）

| 项 | 现状 | 接手时要做的 |
| --- | --- | --- |
| **群昵称格式** | 适配器按 `chat_room.ext_buffer` 的 protobuf（成员 wxid + 群昵称）解析，格式取自开源 4.x 读库工具，**没在真实库上核对**；读不出时退回备注/昵称，不影响其它功能 | 在真实库上用 `chats/members` 看群昵称是否正确；不对就改 `wechat_db/roomdata.py` |
| **真实账号上验证收消息** | 初号机真实加密库和浪味仙私聊已验证；△群元数据/9人成员数、会话选择及独立窗单条出站回执通过 | △群新消息读取字段与持续/模型驱动的群聊互动仍需验收 |
| **把回复输入微信** | `--sender-config` 主窗文字通路已完成初号机与浪味仙模型回发；△已选独立窗也接入 native worker，并通过一条真实出站数据库回执。持久防重生效 | 多会话调度仍待实现；不删除发送日志或补发旧发件箱 |
| **窗口显隐切换** | 协议有 `window/get|set`，控制台有开关（适配器声明 `window` 能力才显示）。**没有实现** | 在适配器里实现，要求不抢焦点 |
| **图片/表情包识别与发送** | 收：知道是图片/表情（表情带描述时一并给模型）；发：模型可输出 `{"sticker":"名字"}`，插件按 `stickers` 配置写入发件箱。**内容识别与真正发出没做** | 收：适配器实现 `media/fetch` 或在 `media.description` 给出描述；插件侧把图片交给多模态模型。发：消费者支持 `sticker`/`image` |
| **真实模型评测** | `/wechat eval` 做好了，没用真实模型跑过 | 在 DSH 里 `/wechat eval off high`，按结果调 `model.reasoningEffort` |
| **DSH Desktop 界面验收** | 在隔离的 DSH web 实例里验证过 `/wechat`、控制台、会话镜像；本机 DSH Desktop 里没逐项点过 | 重启 DSH Desktop 后按 README 走一遍 |

## 4. 模块职责（`plugins/dsh-wechat-bot/lib`）

| 文件 | 职责 | 依赖 DSH |
| --- | --- | --- |
| `chat.js` | 一个群的流水线：命令拦截与插队、合批、模式过滤、对象判断、模型、记忆、发送、定时、健康统计 | 否 |
| `batcher.js` | 合批；排队上限（溢出转上下文）；插队通道；延后（限速/熔断） | 否 |
| `guard.js` | `RateWindow` 限速、`CircuitBreaker` 熔断、`withDeadline` 硬超时、`SendLane` 发送优先通道 | 否 |
| `commands.js` | 命令解析、注册表、内置命令（含 `/cron`）、模式定义 | 否 |
| `cron.js` | 定时：时间解析、时区/夏令时、定时库（限额、只取一次） | 否 |
| `engagement.js` | 定向互动：按 @/昵称找人、开场指令（触发与过滤在 `chat.js` 的 `#turn`） | 否 |
| `models.js` | 模型与思考强度切换（只依赖一个 llm 接口：列模型、查思考档位） | 否 |
| `addressing.js` `prompt.js` `decision.js` `memory.js` | 对象信号、提示词与输入 JSON、输出解析、成员记忆 | 否 |
| `bot.js` | 适配器连接与重启、所服务的群、看门狗 | 否 |
| `protocol.js` `rpc.js` `adapter.js` `simulator.js` | 协议定义与校验、JSON-RPC 传输、插件侧客户端、模拟器 | 否 |
| `store.js` `eval.js` | 落盘、评测场景 | 否 |
| `model.js` `session.js` `app.js` `surface.js` `index.js` | 模型调用、会话镜像、DSH 集成、配置 | 是 |

`adapters/wechat-db/wechat_db`：`source.py`（明文库 / 加密库，解密交给 vendored `db.py`）、`reader.py`（表结构查询与解析）、`content.py`（zstd、XML）、`adapter.py`（协议方法与轮询/状态）、`outbox.py`（默认排队）、`delivery.py`（可选同步发送的独占日志、fsync、防重）、`legacy_sender.py`（旧隐藏桌面 worker 子进程）、`rpc.py`。

## 5. 关键设计决定

1. **事实先于推断**：@、引用来自数据库元数据，程序标注 `addressed`；模型只做最终判断。
2. **整批一次决策**：一批一次模型调用，回复和记忆一起产出；空轮询不调用模型。
3. **宁可漏发，不可重发**：只有确定失败才重试；`clientId` 幂等；定时先出库再发送。
4. **命令永远优先**：运行时直接执行，回复插队；改状态的命令让过时的思考作废。
5. **锁屏只是"暂时不能发"**：由适配器用 `canSend` 声明，插件不检测桌面。
6. **身份只认 id**：wxid 是主键，记忆归属、取消定时、定向互动目标都按它；群昵称、昵称、备注、微信号只是挂在它上面的标签，每次按最新值匹配和显示。没有特权身份。
7. **DSH 会话只做展示**：「微信 · 群名」会话是只读镜像，插件启动时先占用，界面不会抢先打开它。
8. **说不说由脚本决定，说什么由模型决定**：能用确定规则判断的都不交给模型——对象信号、发言模式过滤、`addressed=you` 时必须回复、定向互动的目标识别与触发、回复对象（互动中固定为目标）、记忆只能写给证据消息的发送者、限速与熔断、定时到点。模型只负责措辞，以及在 free/infer 这些"可说可不说"的场合决定要不要接话。新功能照此设计：触发条件写成可测试的程序逻辑，把明确的 `event` 交给模型。

## 6. 运维

- 状态：`~/.dsh/wechat-bot/`（`bot.json` 初始化与活动会话；`chats/<hash>.json` 上下文、记忆、日志、模式、定时；默认模式`wechat-outbox.jsonl`发件箱；真实发送模式`wechat-db/delivery.jsonl`防重日志，另有游标和解密副本）。密钥缓存必须事先配置，本适配器不提取或写回；运行中不要手改或删除发送日志。
- 日志：控制台「处理日志」「连接日志」；`/wechat status`；「微信 · 群名」会话。
- 卸载：DSH 设置 → 插件 → 移除，或 `dsh plugin --profile desktop remove dsh-wechat-bot`。

## 7. 2026-10-22 续做：可选文字发送后端（实现阶段历史）

这一阶段只修改仓库代码、测试和说明，当时未安装插件、读取真实加密库或向微信发送消息，也未提交、推送。下列测试数和下一步计划保留为阶段记录；当前真实验证结果见第8、9节。

| 修改点与实际位置 | 依据与行为 |
| --- | --- |
| `adapters/wechat-db/main.py: main`、`wechat_db/adapter.py: on_initialize/on_message_send/_publish_status/_check_target` | 按协议 §3 的同步回执、错误码、目标 ID 与 §4 的 canSend 接线；默认 outbox 保留。`--sender-config` 与 `--outbox` 互斥；可选模式只允许精确目标的列表、成员、历史、监听和文字发送 |
| `wechat_db/legacy_sender.py: LegacySender/_JsonlChild` | 对照旧项目 `plugins/dsh-wechat-bridge/python/dsh_wechat_bridge/worker.py` 的 `probe/_send/_validate_send_outcome/_close`、`isolated.py` 与 `desktop.py`：复用其精确账号/目标/版本/窗口、隐藏桌面和控件门恢复检查，不复制其插件业务逻辑。单次发送进程延迟创建，JSONL UTF-8、写入和响应有时限；不强杀旧 worker |
| `wechat_db/delivery.py: Delivery` | 协议 §3 的 clientId 幂等与不确定不重发，及 `dsh-plugin-development` §4.6：发送前 fsync attempt、线程串行、独占文件锁、同 ID 请求冲突拒绝、重启恢复回执。未完成 attempt 或 worker 恢复不明时禁发新消息，保留日志供核对 |
| `tests/test_delivery.py/test_sending.py/test_legacy_sender.py/test_transport_integration.py` | 测试真实日志与文件锁、假 worker 子进程和同结构 SQLite 库。覆盖发送发生后中断、跨进程锁、UTF-8、超时/坏帧、关闭失败、跨重启禁发、适配器 EOF 清理与目标限制；不以模拟结果代替真实微信验收 |

以上 `wechat_db/`、`tests/` 均相对 `adapters/wechat-db/`；外部只读参考根为本机 `E:/dsh-wechat-bot`。实现前实际阅读了协议、相关旧源码与 `dsh-plugin-development` 持久化/生命周期/验证指导；独立审查发现的日志末行粘连、清理失败丢失 worker 引用、超范围读取等已修复并补测。

实际验证（仓库根目录）：

- `E:/Anaconda3/python.exe -m pytest adapters/wechat-db/tests -q -p no:cacheprovider`：**70 passed**（最终主 Agent 复跑 35.72 秒）。
- 设置 `WECHAT_DB_PYTHON=E:/Anaconda3/python.exe`，通过本轮临时 Node import hook 只读解析 `E:/dsh-wechat-bot/runtime/node_modules` 的已安装 DSH 依赖，再执行 `node --import <临时模块解析器> --test plugins/dsh-wechat-bot/test/*.test.js`：**96 passed，0 skipped**，含原数据库端到端与 DSH 原生会话测试。未安装依赖；直接在本仓库运行不带解析器的测试，`dsh.test.js` 会缺少 `@deepseek-ai/cordis` 等依赖。
- `python adapters/wechat-db/main.py --help` 和 `git diff --check` 通过。项目只声明 test 脚本，本轮未执行安装或打包。

只读现场核对发现旧 worker 的 `expectedVersion` 与本机微信文件版本同为 `4.1.15.13`，已有隐藏桌面配置；旧 `stateRoot` 仍指向旧项目，不能直接作为新实例状态目录使用。这些只证明文件和配置，不能证明账号在线、控件门参数仍有效或群发送正常。

下一步先核对精确账号、目标群、独立状态目录、微信进程/窗口和控件门参数；本会话明确授权真实操作后再做加密库、单条群收发、焦点与锁屏、DSH Desktop 验收。可选后端仍依赖旧 worker；窗口显隐、真实图片/表情发送与内容识别尚未实现。宿主超时结束适配器后的旧 worker 资源回收尚未现场验证，见适配器 README；未完成 attempt 的重启禁发不等于资源已恢复。本轮没有自动解封恢复异常的接口，也没有断电级持久性验收。

## 8. 2026-10-22 后续真实接入与原生会话选择

干净DSH位于 `E:/dshwxbot/dsh-clean`，回环5311，工作区 `E:/chatwx`。初号机真实账号已登录；与浪味仙的实际入站、真实deepseek-flash生成和微信回发通过。随后按用户要求只测试会话选择、切换和原生独立窗，不增加发送前复核，不重复测试消息。

`sender.json` 顶层 `detachedWindow:true` 启用已有群/私聊列表及单活动目标选择，解决旧固定目标过滤使△群不可见的问题。页面已实际搜索到△（9人群）并完成△→浪味仙→△切换；关闭本次创建的空草稿群窗后再次从页面选择，已自动双击新建△独立窗。辅助进程正常关闭并退出，当前选△、连接正常。

新增入口为 `wechat_db/detached_window.py:prepare_on_desktop`、`native_window_worker.py:NativeWindowRuntime`；接线为 `adapter.py:on_chats_list/on_watch_set`、`legacy_sender.py:select_target/prepare_target`，前端 `client/index.js:ChatPicker`。依据旧wx4py `_ensure_subwindow`、旧worker/process/isolated/gate源码及DSH技能§4/8。群抬头实际带人数（△(9)）；短命worker中的ERROR_BUSY桌面句柄由正常进程退出释放，宿主仍要求exit0。

最终验证Python **121 passed**，Node数据库→插件→发件箱端到端 **1 passed/0 skipped**，客户端语法与diff空白检查通过。详细路径、现场结果与限制见 `E:/dshwxbot/dsh-clean/window-selection-validation.md`；结构化证据 `window-selection-verification.json`，截图 `session-selection-verified.jpg`。独立窗发送路由、多会话并行、群真实收发、媒体和锁屏仍待后续，不以canSend状态替代这些验收。未提交或推送。

## 9. 2026-10-22 △ 独立窗口发送接通

在第 8 节的会话选择工作之后，修复独立窗已打开但发送仍走主窗的问题。`LegacySender._prepare_target_thread` 只在本代 prepare 成功后发布独立窗 worker 配置与参数；`LegacySender.send` 在 detached mode 只用该快照，未准备成功时禁发、不回退主窗。切换目标或清除 watch 会丢弃已准备路由。发送沿用现有 attempt 防重和 close/gate 恢复边界；没有增加额外的发送前整窗复核，原生 runtime 的账号/进程校验、monitor、焦点保护和控件门检查仍执行。

`NativeWindowRuntime` 将 send 派发到 `native_send.py:send_on_desktop`。`NativeUISender` 在选中的独立窗中对 UIA 输入控件标签「输入」写入并核对完整草稿，再点「发送」；成功以精确数据库出站匹配为准，而不是仅以 UI 点击为准。失败的旧请求没有补发。

先用独立验证适配器对 △（9 人群）发送一条修复测试文字。准备过程记录 `canSend:false` → `canSend:true`，随后返回 messageId `5021905145363587369`；数据库证明中同一 messageId 对应目标群、本人发送者和 `fromSelf:true`，适配器退出码为 0。本机结构化证据归档在 `dsh-clean/validation/20261022-triangle-send/send-result.json`，不随仓库分发；本节保留 receipt id 供排障，不记录测试正文或账号、群 wxid。此前失败请求没有补发。

随后加载正式插件，新发 `/help` 的收件、回复及正文哈希均经数据库复核，回复回执 `126267775936878936`。真实模型 `/ask` 后续三段回复的目标、本人发送者及正文哈希逐条与数据库相符，生产journal全部confirmed；最终状态idle、backlog0、模型/发送/内部错误均0。正式群收件→命令/真实模型→独立窗发送通路通过。

Python全测试 **134 passed**；Node数据库→插件→发件箱测试 **1 passed**。本轮Node全套首次91 passed，DSH集成文件因源码未安装宿主依赖而无法启动；临时hook只读解析本次新DSH运行时后，该文件单独 **5 passed**，共96项，不能称为首次全量命令通过。测试fixture已改为虚构账号/会话标识。本机Home、密钥、解密数据库、聊天历史、截图与运行配置不纳入提交。

剩余边界：单活动会话短期验收不代表群长期稳定性、多会话并行、媒体、锁屏或异常停机恢复。只读审计还确认短期上下文有回显重复：`Reader.parse` 先将server_id=0的本地行赋临时ID，`ChatRunner.#receive` 记录后，`#sent` 又按正式回执追加；当前微信数据库对应回复只有单一确认行，journal每个clientId只确认一次。这是上下文合并问题，本轮未修改`chat.js`；后续需按单次发送事务关联临时与正式记录，不能按文本全局去重吞掉合法重复发言。
