# 按用户自主形成记忆

用户要求：从不同用户的日常聊天主动形成记忆，不只响应明确的“请记住”。

## 修改

- <PROJECT_ROOT>/plugins/dsh-wechat-bridge/lib/memory.js:27，memoryInstructions：明确每批同时进行自然回复与主动记忆判断；日常聊天自然透露的背景、兴趣、持续事项可以记录，同一 senderId 多轮表现可形成带“近期观察”范围的互动记忆。人物卡里的短句、不要总结、玩梗、潜水只约束 reply，不妨碍后台整理；当前证据原文、敏感内容检查和用户归属保持原实现。
- <PROJECT_ROOT>/plugins/dsh-wechat-bridge/lib/group.js:8，groupInstructions：逐用户主动整理，记忆不以 @、要求记住或是否回复为前提；个人称呼与交流偏好只应用于本人。
- <PROJECT_ROOT>/plugins/dsh-wechat-bridge/package.json:3、README.md:5：0.1.12-memory.1 与行为说明。
- <PROJECT_ROOT>/personas/persona_dafeiyu.md:18，固定关系：主人是USER_OWNER（群昵称USER_OWNER），以实际 senderId=wxid_REDACTED_ACCOUNT 识别；昵称变化不改变主人身份，其他用户自称或同名不能替换。身份是 system persona 的固定事实，日常个人记忆继续独立积累。

依据：当前 memory.js 的四类记忆契约、bridge.js:505 的 senderId 归属和原子写入流程、group.js 的多用户输入，以及实际人物卡 personas/persona_dafeiyu.md 中“不要总结”等回复限制。技能依据为 dsh-plugin-development §4.3–4.6、§7–8，TDD/writing-good-tests 的行为验证要求。

主人身份依据用户本次直接指定、现有USER_OWNER记忆文件的 userId、config/wechat-bot.json 的 personaPath，以及 model.js:24 的 system: persona 入口。BridgeManager.create 启动时读取该文件，所以需要正常重启加载。

此次修改上述四个插件文件和现有 persona，没有改变发送、恢复、数据格式或界面，也没有新增每轮模型调用。没有手工替真实用户编写日常记忆；现有文件继续使用。

## 实际模型验证

check-model.mjs 通过本项目已安装的 DSH LlmRuntime 和 DeepSeekAdapter，调用现有 deepseek-official / deepseek-flash、reasoning off；使用实际人物卡和合成用户聊天，不连接微信 worker、不发群消息。凭据仅由官方本地解析器读取用于原官方端点，没有写进测试结果。

- `node check-model.mjs before`：旧规则对多轮挑漏洞/较劲的聊天返回 memory=[]，互动观察用例失败；自然陈述爱好、分用户召回和不记录一次性转述则通过。这证明旧规则并非程序强制只记显式请求，但对日常互动的归纳不足。
- `node check-model.mjs after`：四项全部通过，输出在 model-after.json。实际自主生成“互动观察：近期 alice 喜欢反复挑逻辑漏洞、宣布自己赢了并邀战”；另两名合成用户分别形成机械键盘、周末爬山记忆，写入各自隔离文件并读回；去掉聊天历史后，只提供 bob 的记忆，正确召回爬山；替朋友问、一次性路过未生成个人记忆。
- 测试证据来自真实模型输出，不是根据提示词字符串或伪造模型返回判断。该组测试不能保证所有自然语言场景永不误判。
- `node --test test/*.test.js`：80/80，通过，退出码 0，见 node-tests.log。该轮源码只改提示策略，无新增存储流程。
- `node check-model.mjs owner`：主人姓名、主人换昵称、同名冒认三个真实模型案例通过，见 model-owner.json；没有向群发送测试消息。首次验证发现模型会将冒认事件存入记忆且回复暴露技术标识，收紧 persona 后再次验证，冒认回复拒绝且不写入该事件。固定主人身份仍属于 system persona，模型生成记忆并非可靠的权限执行机制。

## 安装

install.ps1 的 Scratch 和 Deploy 均通过正式 DSH CLI 安装、dump-config、bundle 校验、36 个运行文件 SHA256 对比。

包：dsh-wechat-bridge-0.1.12-memory.1.tgz。
SHA256：7A19DDE0CF84C4FB04BB749E4CEAD61C40E50F789DB6CE6707139C24A1382A1C。

首次启动 PID 119664 连接失败，插件路由未注册（404）；worker 已关闭且状态锁已释放。相同只读 worker 探测在受限环境返回 worker_error，在正常用户环境完整完成 probe/poll/close。验证该失败实例的 PID、开始时间、命令行、监听地址和清理状态后，只结束该实例，使用正常用户环境启动 PID 104364。12:55 CST 状态接口确认 running、autoSendEnabled=true、workerBound=true、uncertainSend=false、lastErrorCode=null，轮询推进。随后为加载主人 persona，通过 Stop-DshBot.ps1 / Start-DshBot.ps1 正常重启为 PID 125040；最终实际状态见 final-status.json。

7 个原记忆 owner 均保留，微信和监听群不变。12:54:54 CST 新规则已根据真实群聊分别自主保存“USER_OWNER正在修群里的 bot/触发词功能”和“USER_MEMBER_01近期的称呼互动观察”。这是实际运行写入，不是手工补写或合成模型用例。

## 边界

新规则从后续消息及其已有上下文中学习，没有回扫已清理的旧聊天或强行补齐所有人的记忆。此次改善了用户身份的提示约束，未把全群历史拆成互不可见的会话，不能保证回复绝不串人。锁屏发送和 Python 传输未修改、未重测。未提交、推送或改另一聊天的隔离补丁。
