# 监听中断恢复与模型错误处理修复

2026-10-21 12:27，Asia/Shanghai。GROUP_TARGET 群监听及自动回复已恢复。DSH PID 67576，版本 0.1.12-recovery.1；原微信 PID 91492 和隐藏桌面 keeper PID 121952 未重启。

## 本次原因与恢复

12:13:36 模型将上一轮“以后开头写喵”的原文，作为当前“这样多清楚”的记忆证据。parseMemoryReply 的逐字证据检查正确抛出 memory_evidence_invalid，但异常被 #pollLoop 外层捕获，关闭 worker 并将整个监听置为 error。这次没有进入发送，不涉及发送结果不确定或残留草稿。

先通过正式 start API 恢复运行；恢复后确认送达数从 56 增至 58。随后安装修复并正常重启专用 DSH，自动开始监听，无需再次调用 start API。12:27:08 状态为 running/workerBound/autoSendEnabled/sendGrantValid=true，uncertainSend=false，lastErrorCode=null；浏览器也显示“正在监听 · 微信已连接 · 自动回复已开启”。

## 修改与依据

| 文件和位置 | 修改及依据 |
|---|---|
| <PROJECT_ROOT>/plugins/dsh-wechat-bridge/lib/bridge.js:531、:588、:621 | 只在模型生成和纯校验阶段捕获 ModelError，附错误原因重新生成一次；仍失败则将该批明确记为 model_failed 并持续监听。空闲检查失败也记录错误并按原周期安排下一次。发送、状态写入、记忆文件发布、worker 故障不被这个分支吞掉。依据当前 generateReply、parseMemoryReply、applyMemory 以及 #draft 提交/发送顺序。 |
| <PROJECT_ROOT>/plugins/dsh-wechat-bridge/lib/memory.js:39 | 明确 messageId/quote 只能引用最后一条用户输入的当前清单，禁止引用历史相同编号；保留原严格校验。依据实际错误输出与当前输入的原文对照。 |
| <PROJECT_ROOT>/plugins/dsh-wechat-bridge/lib/console-log.js:12、lib/retention.js:10 | 失败批次在完整日志明确显示错误，不伪装为成功或沉默；按既有 30 分钟策略清理正文。依据 StateStore 的 inbox 状态与原日志/保留机制。 |
| <PROJECT_ROOT>/plugins/dsh-wechat-bridge/test/group.test.js:98、:118、:152、:172；test/batching-memory.test.js:107；test/memory-retention.test.js:49 | 覆盖纠正后只发送有效答案、两次失败无记忆写入/无发送且后续消息仍可回复、重启不重放失败批次、空闲失败保持监听、纠正中取消、失败正文保留期限。 |
| <PROJECT_ROOT>/plugins/dsh-wechat-bridge/package.json:3、README.md:5 | 版本 0.1.12-recovery.1 和行为说明。 |

共同依据：<CODEX_HOME>/skills/dsh-plugin-development/SKILL.md §4.3–4.6、§7–8；systematic-debugging 的原始错误→调用链→最小修复流程；test-driven-development 及 writing-good-tests 的行为验证要求。没有增加控制台区块、按钮或额外确认流程。

## 验证

- 新行为在修复前产生 5 项预期失败，详见 tests-red.log；实施后 `node --test test/*.test.js` 全量 80/80 通过，退出码 0，见 tests-green.log。
- `install.ps1 -Stage Scratch` 和 `-Stage Deploy` 均通过官方 DSH CLI 安装、dump-config、bundle 校验及 36 个运行文件 SHA256 核对。
- 包 SHA256：C64517CA5008B0823ECB92C77347C75C4C8ECBC8DE8C8E6153D0F602098AF9FE。
- Stop-DshBot.ps1 正常退出原实例，Start-DshBot.ps1 启动新实例；API 和实际浏览器确认自动恢复。最终状态在 final-status.json，部署前错误及输出在 before-deploy-logs.json。
- 修复后已验证持续轮询；部署后截至本次检查没有新群消息，未人为向群发送测试消息。模型纠正和失败隔离路径由离线行为测试验证，没有在真实群中故意制造错误。
- Python/锁屏发送未改动或重测；原间歇 foreground_guard 原因仍未确认修复，本次只修复已证实的模型错误中断。未提交、推送或改其他聊天的隔离补丁。
