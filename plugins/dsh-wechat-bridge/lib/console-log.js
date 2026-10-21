// A read-only view of the retained conversation records and current host activity.
export function conversationLog(state, activity = []) {
  const entries = [...activity]
  const batches = new Set()
  for (const item of state.inbox) {
    if (item.kind !== 'idle') entries.push({
      id: `received:${item.key}`, at: item.receivedAt, kind: 'received', level: 'info',
      title: `收到消息 · ${item.senderName ?? item.senderId}`,
      text: item.text ?? '（正文已按保留期限清理）',
    })
    const batch = item.batchId ?? item.key
    if (item.status === 'model_failed' && !batches.has(batch)) {
      batches.add(batch)
      entries.push({ id: `model_failed:${batch}`, at: item.modelFailedAt, kind: 'model_failed', level: 'error',
        title: '本批模型处理失败，未发送；监听继续', text: item.modelErrorCode })
    }
    if (item.draftAt && !batches.has(batch)) {
      batches.add(batch)
      entries.push({ id: `reply:${batch}`, at: item.draftAt, kind: 'reply', level: 'info',
        title: item.decision === 'silent' ? '模型决定不回复' : '模型回复',
        text: item.draft ?? (item.decision === 'silent' ? '' : '（正文已按保留期限清理）') })
    }
  }
  for (const item of state.outbox) {
    entries.push({ id: `send:${item.attemptId}`, at: item.attemptedAt, kind: 'send', level: 'info',
      title: '准备发送', text: item.text ?? '（正文已按保留期限清理）',
      details: { attemptId: item.attemptId } })
    const failed = item.status === 'ambiguous' || Boolean(item.errorCode)
    if (item.status !== 'attempted' || failed) entries.push({
      id: `result:${item.attemptId}`, at: item.deliveredAt ?? item.failedAt ?? item.attemptedAt,
      kind: 'send_result', level: failed ? 'error' : 'info',
      title: failed ? '发送未完成' : '发送已确认', text: item.errorCode ?? '',
      details: { attemptId: item.attemptId, reasonCode: item.reasonCode,
        sendAttempted: item.sendAttempted, serverId: item.serverId,
        focusDiagnostic: item.focusDiagnostic },
    })
    if (item.resolution) entries.push({ id: `resolution:${item.attemptId}`, at: item.resolution.at,
      kind: 'resolution', level: 'info', title: '已跳过，不重发', text: '',
      details: { attemptId: item.attemptId, action: item.resolution.action } })
  }
  if (state.idleDecision) entries.push({ id: `idle:${state.idleDecision.at}`, at: state.idleDecision.at,
    kind: 'idle', level: state.idleDecision.decision === 'failed' ? 'error' : 'info', title: '群空闲检查',
    text: state.idleDecision.decision === 'failed' ? state.idleDecision.errorCode
      : state.idleDecision.decision === 'silent' ? '模型决定保持安静' : '模型决定回复' })
  return entries.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
}
