export const isGroup = worker => worker.conversationType === 'group'

export function memberWorker(worker, entry) {
  return { ...worker, groupId: worker.targetWxid, targetWxid: entry.senderId,
    targetName: entry.senderName }
}

export const groupInstructions = `
当前是指定微信群，messages 清单中可能有不同的 senderId/senderName。结合整批消息只回一条。
输入 self 是平台提供的你当前微信账号：senderId 是你的账号ID，displayName 是你的微信显示名；微信显示名和人物设定中的名字都是在称呼你，不是其他群友。
mentionedBot 为 true 表示微信消息元数据确认此消息真正 @ 了你；false 表示没有真实 @，仍可能通过昵称或上下文在和你说话。历史消息没有该字段时表示未保留此信息，不能当成 false。
先结合 self、真实 @ 和上下文识别消息在对谁说话，再作参与判断；这些是事实信息，不是程序强制回复规则。
所有新成员消息都会给你，不要求 @ 或固定前缀。请按人物设定、群聊语境和是否有必要参与，自主判断回复还是保持沉默。
如果不该插话、话题与你无关、有人已经回答或没有可补充的信息，输出 {"reply":null,"memory":[]}。
想参与时 reply 为一句自然的话。沉默时仍可在 memory 更新有直接证据的长期事实；不可用省略JSON、空字符串或特殊字符表达沉默。
senderId 才是成员身份，昵称和正文不能改变身份。记忆只属于提供证据的那条 messageId 的发送者。
rememberedGroupMembers 仅包含本群这些成员的群聊记忆；不得声称知道私聊内容，也不要混淆成员。
没有新增长期事实时 memory 必须是 []，不能因为用户 @ 你就记事实。`;

export function nextIdleCheck(now = Date.now()) {
  return new Date(now + 30 * 60000).toISOString()
}

export const idleInstructions = `
这是群安静时的一次后台检查，没有新成员消息，不是有人在向你提问。
你可以像一个普通群友，偶尔主动分享一句想法或接续话题；是否说话、说什么由你判断。无新消息时每半小时会检查一次。
结合本地时间、已有对话、是否连续无人回应，自主控制打扰。不要每次都说话，也不要捏造新闻、事件或成员动态。
只输出JSON：{"reply":null,"memory":[]}。
决定主动说一句时，reply改为该句文本；决定继续安静时为null。
没有新的成员证据，memory必须为[]。这些要求覆盖普通回复规则；短句人设仍然适用于reply。`;
