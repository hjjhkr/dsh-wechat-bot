# 控制台精简与服务恢复

2026-10-21，Asia/Shanghai。控制台：http://127.0.0.1:5310/wechat-bot/。

服务已恢复，原 GROUP_TARGET 群继续监听并自动回复。页面只保留监听会话选择、连接状态、完整日志；日志展示保留期内的消息正文、模型完整输出、回复、发送确认和错误诊断。服务启动后自动监听，选择新会话后不需要再点启动。部署后已验证真实回复送达；最新状态见 final-status.json。

## 修改位置与依据

| 实际路径与位置 | 修改及依据 |
|---|---|
| <PROJECT_ROOT>/plugins/dsh-wechat-bridge/lib/ui.js:1，renderPage | 主页面仅三块，删除开始/暂停、授权、草稿、模型诊断、停止实例和人工处理区；保留搜索选择会话。依据用户明确的界面要求，以及原页面的选择/API 调用方式。日志用 textContent 显示完整文本；页面会话失效时重新取得同源 cookie 后继续读取。 |
| <PROJECT_ROOT>/plugins/dsh-wechat-bridge/lib/console-log.js:2，conversationLog；lib/bridge.js:924，#log/logs；lib/http.js:157，GET /wechat-bot/api/logs | 用已有 inbox/outbox 记录拼接完整收发日志，补充本次进程的连接、模型开始和完整输出。依据原 StateStore 快照、inbox.draft/outbox 送达记录和模型调用入口；HTTP 沿用本机鉴权与 no-store，不读取含凭据的宿主 stdout。历史正文仍遵循原保留策略；连接及原始模型活动是本次进程内记录。 |
| <PROJECT_ROOT>/plugins/dsh-wechat-bridge/lib/bridge.js:203，recover；config/wechat-bot.json:36 | autoStart=true；正常启动恢复当前会话及已有有效发送许可。依据原 recover/#launch 和已保存 sendGrant 的作用域校验。 |
| <PROJECT_ROOT>/plugins/dsh-wechat-bridge/lib/conversations.js:28，selectedConfig；:74，selectConversation | 会话选择提交后立即启动；保持独立会话状态目录，并在保存失败时保留原回滚行为。依据原 ConversationManager 的串行切换、配置持久化和显式选择入口。 |
| <PROJECT_ROOT>/plugins/dsh-wechat-bridge/test/bridge.test.js:52；test/http.test.js:9；test/conversations.test.js:51 | 验证无页面会话时默认监听、完整日志正文与错误详情、日志鉴权、选择后自动启动。新增用例先失败，再实施通过。 |
| <PROJECT_ROOT>/plugins/dsh-wechat-bridge/package.json:3；README.md:5 | 记录 0.1.12-console.1 及新控制台行为。 |

共同技能依据：[dsh-plugin-development/SKILL.md](<CODEX_HOME>/skills/dsh-plugin-development/SKILL.md) §4.3–4.6（生命周期、HTTP、状态）、§7–8（正式安装和实际组合验证）；排障采用 systematic-debugging 的日志/代码/现场证据顺序。

## 服务恢复的实际原因

第一次恢复后，发送在 uia_draft 阶段失败。隐藏桌面只读检查确认群和账号正确，但输入框有残留；与已标为不重发的 0fe10d70-7906-4d41-ad4e-8f23a030d290 内容完全一致。只清除该条已放弃的机器人草稿，读取确认空输入框，sendCalls=0、gateRestored=true。新失败记录 87d06859-4569-4cde-a994-16974e54afaf 也通过正式 API 记为不重发，随后恢复正常自动回复。

证据：isolated-chat-controls.json、isolated-chat-controls-focus.json。执行前的精确匹配结果在当前聊天工具记录中；清理后的结果保存在 JSON。未修改微信数据库，也未重发失败回复。

## 验证与边界

- 插件目录：`node --test test/*.test.js`，76/76 通过；日志 node-tests.log。实际页面输出的 JavaScript 经 node:vm 解析通过。
- `_work/20261021-console/install.ps1 -Stage Scratch` 和 `-Stage Deploy`：正式 DSH CLI 安装及 dump-config 均通过，36 个运行文件哈希匹配。
- 按 Stop-DshBot.ps1 / Start-DshBot.ps1 正常重启，新 PID 89164；没有重启微信。未再调用 start API，宿主启动后自动监听、自动回复已实际验证。
- 浏览器确认只有三块，搜索 GROUP_TARGET 正确显示当前群；未切换到其他聊天。完整日志可见本次模型输出和发送确认；浏览器无 error/warn。截图 console.png。
- 锁屏发送未验证；原 foreground_guard 间歇异常的内部原因仍未确定，不能把这次草稿清理称为该异常的根治。
- 没有合入另一聊天的 DSH 模型会话补丁，没有提交、推送或发布。

安装包：dsh-wechat-bridge-0.1.12-console.1.tgz；SHA256：6B745EFB19306CF0619F04DBE5C460B55BC0D703C7D7E3E16E91F0FF374CC690。
