# DSH 模型会话接入：代码与测试交付

按用户最新要求，本轮仅完成代码和测试。代码保存在独立目录，没有安装、合入共享源码或重启 DSH。当前运行实例尚未获得本功能。

## 行为

DSH 将出现 `微信模型 · <聊天名称>` 原生会话，展示同一次模型调用的运行状态、实时输出、完成、失败与取消。原有的人设、历史、记忆与模型请求次数不变。DSH 停止按钮取消当前模型请求；模型完成并不表示微信已发送成功。

普通 DSH 输入被拒绝；微信控制页的模型诊断也会显示在该会话中。诊断与监听保持互斥。仍只有一个当前微信目标，没有实现多窗口监听或并发。

DSH 原生历史保存模型输入与结构化输出，独立于插件 30 分钟 inbox/outbox 清理。这些展示历史不会额外回灌给模型。重新打开只恢复记录并闭合中断回合，不重放模型调用或微信发送。

## 修改位置与依据

以下代码都位于 `<PROJECT_ROOT>/_work/dsh-model-session/staged-plugin`。

| 修改位置 | 内容 | 对应依据 |
| --- | --- | --- |
| [lib/model-session.js:10](<PROJECT_ROOT>/_work/dsh-model-session/staged-plugin/lib/model-session.js:10)，ModelSessionActivity.create/run/dispose | 稳定会话 ID、原生状态/流、持久化、取消与恢复 | 官方 dsh-agent/lib/types/runtime-types.d.ts:107 的帧和 Agent 契约；dsh-agent/lib/index.js:512 的 enter/announce；dsh-session/lib/types/index.d.ts:434 的生命周期；dsh-agent-loop/lib/index.js:1992 的中断恢复顺序 |
| [lib/model.js:12](<PROJECT_ROOT>/_work/dsh-model-session/staged-plugin/lib/model.js:12) | 观察原有请求并逐块转发 | 原项目 generateReply 的请求/stop 校验；官方 dsh-llm/lib/types/assistant-stream.d.ts:51 与 assembler.d.ts:22 |
| [lib/index.js:6](<PROJECT_ROOT>/_work/dsh-model-session/staged-plugin/lib/index.js:6)、[lib/bridge.js:133](<PROJECT_ROOT>/_work/dsh-model-session/staged-plugin/lib/bridge.js:133)、[lib/conversations.js:43](<PROJECT_ROOT>/_work/dsh-model-session/staged-plugin/lib/conversations.js:43)、lib/diagnostics.js 的 testBatchMemory | 服务注入；响应、主动检查、诊断、切换/回滚接线及关闭 | 原项目 BridgeManager.create/recover/dispose 与 ConversationManager.serial；技能 §4.1/4.3/4.6 的依赖、所有权与隔离规则 |
| [lib/config.js:45](<PROJECT_ROOT>/_work/dsh-model-session/staged-plugin/lib/config.js:45)、package.json、[README.md:3](<PROJECT_ROOT>/_work/dsh-model-session/staged-plugin/README.md:3) | 工作区绝对路径校验、官方 peer、功能与保留说明 | 技能 §3.2 的共享 runtime peer 和 host-only 契约、§4.6 的显式路径；本机官方包版本 0.2.1-rc.2 |
| [test/model-session.test.js:44](<PROJECT_ROOT>/_work/dsh-model-session/staged-plugin/test/model-session.test.js:44) | 6 项真实服务组件离线测试 | 技能 §8.1/8.2 的状态、持久化、失败与 disposer 验证 |

技能来源：[dsh-plugin-development/SKILL.md](<CODEX_HOME>/skills/dsh-plugin-development/SKILL.md)。上述官方包均读取自 `<PROJECT_ROOT>/runtime/node_modules/@deepseek-ai/`，未修改官方代码。

## 验证

在隔离插件目录执行：

```powershell
& 'C:\Program Files\nodejs\node.exe' --test test/*.test.js
```

结果 **79/79 PASS，0 fail，0 skip**。新增测试验证正在执行时的原生状态与流、原请求参数与单次调用、异常/截断/空输出、停止取消、重开恢复、桥接诊断互斥及中断回合闭合。日志：[node-tests-staged.log](<PROJECT_ROOT>/_work/dsh-model-session/node-tests-staged.log)。使用真实官方 Session、AgentRegistry、Projection、Title 和 JSONL 持久化，模型与微信使用离线替身。

在工作区根目录执行只读应用检查：

```powershell
& 'C:\Program Files\Git\cmd\git.exe' apply --check --whitespace=error-all '_work/dsh-model-session/dsh-model-session.patch'
```

当前共享 0.1.12 源码检查通过，未实际应用。项目没有声明独立 typecheck/build/verify；这是直接执行的 JavaScript 插件。未变更 Python，因此未重复跑 Python 测试。

## 合并交付物与后续边界

- [dsh-model-session.patch](<PROJECT_ROOT>/_work/dsh-model-session/dsh-model-session.patch)：本次 10 文件补丁，不含另一任务的 Python 改动。
- [manifest.json](<PROJECT_ROOT>/_work/dsh-model-session/manifest.json)：基线/提议 SHA256；基线 0.1.12，隔离提议暂定 0.1.13。另一任务改动后需重新核对，不能强行覆盖。
- [staged-plugin](<PROJECT_ROOT>/_work/dsh-model-session/staged-plugin)：完整离线测试快照。不要整目录覆盖共享插件，其他代码可能落后于另一项工作。
- 实际 config/wechat-bot.json 未改；安装前须添加绝对 dshWorkspace，指定 DSH 会话归属的工作区。缺失时明确报错，不静默选进程 cwd。
- 本轮没有安装、Loader/profile 组合启动、浏览器界面验收、真实模型调用或微信收发验证；这些要在另一项工作完成并合并后验证。没有修改微信状态或已有不确定发送记录，没有执行重试。
