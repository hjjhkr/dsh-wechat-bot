# 反复发送保护失败：诊断与修复

## 根因与修改

- `plugins/dsh-wechat-bridge/python/dsh_wechat_bridge/uia_send.py` 的 `_FocusMonitor.safe` 原先重新查询发送开始时的窗口句柄。那个普通窗口关闭后，查询返回 PID 0，即使整段监测都没有小号获得焦点，也会误报。现在使用监测开始时已验证的 PID 快照；当前窗口、采样和焦点事件仍检查。
- `python/dsh_wechat_bridge/isolated.py` 的 `MonitorLease` 同步采用起始 PID 快照。另一个实际错误表现为 `monitorFailed=true`、没有焦点异常；自有文件实验复现了监测文件正在被读取时，原子发布触发 `PermissionError / WinError 5`。读者现在共享删除权限，更新已有文件使用 Win32 `ReplaceFileW`。这是已复现的并发文件错误，但未捕获那条线上事件的原始异常，不能把所有旧失败都归因于它。
- `tests/python/test_isolated.py` 覆盖起始窗口关闭、读取与真实发布交叠、撤销后拒绝；`tests/python/test_uia_send.py` 覆盖起始身份不可被后来句柄复用补救。

依据：DSH 插件技能 §4.3–4.6、7、8；当前发送/监测/门控源码；实际诊断样本；[Microsoft ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew) 及本机读写实验。没有用忽略异常或自动重发绕过错误。

## 验证

- Python `unittest discover -s tests/python`：80/80，见 `python-tests-green.log`。
- Node `node --test test/*.test.js`：80/80，见 `node-tests.log`。
- 本机自有窗口关闭实验：旧判定失败、新判定通过；实际小号只读监测 133 个样本通过，见 `native-focus-verification.json`。
- 本机自有文件读写交叠：旧方法失败，`ReplaceFileW` 后旧读者保有完整快照，新读者看到新状态，见 `replacefile-probe.json`。
- 正式 DSH CLI scratch / deploy 安装成功，36 个运行文件哈希一致。包版本 `0.1.12-focus.2`，SHA256 `690DDC2066E8C0271276714B31495CBD59EA349983EDE4314FD2E0A4D9BA2D93`。
- 正常关闭旧实例后启动 PID 75348。13:26 CST 状态：running、autoSendEnabled=true、workerBound=true、uncertainSend=false、lastErrorCode=null；轮询持续推进，历史确认发送数 81。

## 恢复与边界

沿用用户明确的“不重发旧回复”决定，将对应失败尝试通过审计 API 记为 abandoned。隐藏微信里遗留的草稿与其中一个 abandoned / skip_no_retry 的正文逐字匹配后才清空，见 `draft-recovery.json`；没有点击发送。随后恢复 GROUP_TARGET 群监听和自动回复。

未向微信发送合成测试消息；本次未重新验证锁屏发送。自主记忆和USER_OWNER主人 persona 均保留在当前部署中，详见 `../20261021-autonomous-memory/RESULTS.md`。后续用户新增显隐按钮需求另行处理，不属于上述验证结论。
