export function renderPage(nonce) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>小鲸鱼 · 微信助手</title>
  <style nonce="${nonce}">
    :root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif;background:#f4f7fb;color:#172033}
    *{box-sizing:border-box}body{margin:0;padding:24px;max-width:780px;margin-inline:auto}
    h1{font-size:1.45rem;margin:0 0 4px}.muted{color:#65718a}.card{background:#fff;border:1px solid #dde4ef;border-radius:12px;padding:18px;margin:16px 0;box-shadow:0 4px 16px #15284a0c}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}button{border:0;border-radius:8px;padding:10px 16px;background:#1769aa;color:white;font:inherit;cursor:pointer}button.secondary{background:#e8eef6;color:#24324a}button:disabled{opacity:.55;cursor:not-allowed}
    label{display:flex;gap:9px;align-items:flex-start;margin:12px 0}input{margin-top:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f7fb;padding:12px;border-radius:8px;min-height:48px}#status{font-weight:600}#error{color:#a22}small{display:block;color:#65718a;margin-top:10px}
    dialog{width:min(620px,calc(100vw - 32px));max-height:85vh;padding:22px;border:1px solid #dde4ef;border-radius:14px;background:#fff;color:inherit}dialog::backdrop{background:#101a2a80}dialog h2{margin:0;font-size:1.2rem}.dialog-head{display:flex;justify-content:space-between;align-items:center;gap:12px}
    #conversationSearch{width:100%;padding:11px 12px;border:1px solid #bac7da;border-radius:8px;font:inherit;margin:16px 0 8px;background:transparent;color:inherit}#conversationList{max-height:36vh;overflow:auto;border-block:1px solid #dde4ef;padding:5px 0}.conversation-option{padding:10px;border-radius:8px;margin:2px 0;cursor:pointer}.conversation-option:has(input:checked){background:#e8f1fc}.conversation-option small{margin:0;overflow-wrap:anywhere}.dialog-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}#conversationError{color:#b22;min-height:1.5em}button:focus-visible,input:focus-visible{outline:3px solid #70a9e8;outline-offset:3px}
    @media(prefers-color-scheme:dark){dialog{background:#1c2533;border-color:#344158}.conversation-option:has(input:checked){background:#263e5c}#conversationList{border-color:#344158}}
    @media(prefers-color-scheme:dark){:root{background:#121722;color:#e5ebf5}.card{background:#1c2533;border-color:#344158}pre{background:#121722}.muted,small{color:#aab6c8}button.secondary{background:#344158;color:#e5ebf5}}
  </style>
</head>
<body>
  <h1>小鲸鱼 · 微信助手</h1>
  <div class="muted" id="scopeHint">仅处理配置的一个会话。</div>
  <section class="card">
    <div class="row" style="justify-content:space-between">
      <div><strong>监听会话</strong><div id="selectedConversation" class="muted">正在读取…</div></div>
      <button id="chooseConversation" class="secondary">选择会话</button>
    </div>
    <small>一次监听一个会话。切换时保留各自的记忆和进度，切换后由你启动。</small>
  </section>
  <dialog id="conversationDialog" aria-labelledby="conversationTitle">
    <div class="dialog-head"><h2 id="conversationTitle">选择监听会话</h2><button id="closeConversations" class="secondary" aria-label="关闭会话选择">关闭</button></div>
    <input id="conversationSearch" type="search" aria-label="搜索会话" placeholder="搜索群名、昵称或账号" autocomplete="off">
    <div class="muted" id="conversationCount" role="status">正在读取…</div>
    <div id="conversationList" role="radiogroup" aria-label="可选会话"></div>
    <small>目标需要在BOT_ACCOUNT的微信会话列表中。同名会话无法自动区分；已有草稿会保留并阻止切换。</small>
    <label><input id="confirmConversation" type="checkbox"><span>暂停当前监听，在隐藏桌面切换到选中的会话。切换后先保持暂停，不发送消息。</span></label>
    <div id="conversationError" role="alert"></div>
    <div class="dialog-footer"><button id="reloadConversations" class="secondary">刷新列表</button><button id="applyConversation" disabled>切换到此会话</button></div>
  </dialog>
  <section class="card">
    <div>连接状态：<span id="status">正在读取…</span></div>
    <div class="muted" id="detail"></div>
    <div class="muted" id="batchPolicy"></div>
    <div class="muted" id="idlePolicy"></div>
    <div class="row" style="margin-top:14px">
      <button id="start">开始只读监听并生成草稿</button>
      <button id="pause" class="secondary">暂停监听（保留当前授权）</button>
    </div>
    <small id="desktopHint">请保持小号登录且选中目标私聊。切换聊天与锁屏场景目前不支持。</small>
  </section>
  <section class="card" id="uncertainCard" hidden>
    <h2 style="font-size:1.05rem;margin-top:0">待人工核对的发送</h2>
    <p>发送状态不明确时不会自动重试。请用下方 attempt ID 对照微信和“最新草稿”核对；确认不再尝试后，勾选确认并跳过该条消息。此操作不会补发，也不会自动恢复监听。</p>
    <div id="uncertainAttempts"></div>
  </section>
  <section class="card">
    <h2 style="font-size:1.05rem;margin-top:0">自动发送</h2>
    <label><input id="autoSend" type="checkbox"><span id="grantHint">授予“小鲸鱼”向当前配置会话自动发送的权限。</span></label>
    <label><input id="allowGate" type="checkbox"><span>我同意在此本机范围内，每条发送前短暂开启微信控件门（最多 30 秒）并在发送后恢复；无法确认恢复时立即停止。</span></label>
    <button id="startAuto">保存授权并启动常驻模式</button>
    <button id="revoke" class="secondary">撤销发送授权并暂停</button>
    <small>默认关闭。发送许可写入本机状态并绑定账号、接收人、微信版本和 gate 配置；关闭页面和正常 DSH 重启不会撤销。暂停会停止轮询但保留授权，撤销按钮会永久清除此范围许可。每条消息发送前会持久记录尝试；结果不明确时不会自动重发，需要人工核对。</small>
  </section>
  <section class="card">
    <h2 style="font-size:1.05rem;margin-top:0">最新草稿</h2>
    <pre id="draft">尚无草稿</pre>
    <button id="refreshDraft" class="secondary">刷新草稿</button>
  </section>
  <section class="card">
    <h2 style="font-size:1.05rem;margin-top:0">DeepSeek 连通性</h2>
    <button id="testModel" class="secondary">测试模型（只调用 DeepSeek，不发微信）</button>
    <pre id="modelReply">尚未测试</pre>
  </section>
  <section class="card">
    <h2 style="font-size:1.05rem;margin-top:0">停止专用 DSH 实例</h2>
    <p>会先停止监听、关闭插件的后台进程并释放状态锁，再正常退出这个实例；微信账号保持登录。重新启动请运行 <code>C:/ExampleProject\\Start-DshBot.ps1</code>。</p>
    <button id="shutdown" class="secondary">正常停止 DSH</button>
  </section>
  <section class="card">
    <div id="counts" class="muted"></div>
    <div id="error"></div>
  </section>
  <script nonce="${nonce}">
    const $ = (id) => document.getElementById(id);
    const call = async (path, method='GET', body) => {
      const response = await fetch(path, {method, credentials:'same-origin', headers:body ? {'Content-Type':'application/json'} : {}, body:body ? JSON.stringify(body) : undefined, cache:'no-store'});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'request_failed');
      return data;
    };
    const statusText = (s) => ({running:'运行中',paused:'已暂停',stopped:'未启动',starting:'正在启动',error:'错误'}[s] || s);
    let initialized = false;
    let uncertainRenderKey = '';
    let currentTargetId = null, selectedTargetId = null, catalogCurrentId = null;
    let conversationRows = [], conversationBusy = false, hasUncertainSend = false;
    async function refresh() {
      try {
        const s = await call('/wechat-bot/api/status');
        $('status').textContent = statusText(s.phase) + (s.workerBound ? ' · 微信已绑定' : '') + (s.waitingForDesktop ? ' · 等待解锁，继续只读收取消息' : '') + (s.uncertainSend ? ' · 有待人工核对的发送' : '');
        const group = s.conversationType === 'group';
        currentTargetId = s.targetId;
        hasUncertainSend = Boolean(s.uncertainSend);
        $('selectedConversation').textContent = (group ? '群聊 · ' : '私聊 · ') + s.targetName;
        updateConversationButton();
        $('scopeHint').textContent = group ? '仅群“' + s.targetName + '”：新消息合批交给模型，自主决定回复或保持沉默。记忆按本群成员分开。' : '仅私聊“' + s.targetName + '”。';
        $('idlePolicy').textContent = group && s.proactiveEnabled ? '无新消息每半小时由模型判断是否主动开口 · 下次检查：' + (s.nextIdleCheckAt ? new Date(s.nextIdleCheckAt).toLocaleString() : '等待安排') : '';
        $('grantHint').textContent = '授予“小鲸鱼”常驻向当前' + (group ? '群“' : '私聊“') + s.targetName + '”自动回复的权限。';
        $('detail').textContent = s.botName + ' → ' + s.targetName + ' · ' + s.provider + ' / ' + s.model + ' · reasoning off · 工作进程关闭：' + (s.workerClosed ? '是' : '否') + ' · 控件门：' + (s.gateActive === false ? '已恢复' : s.gateActive === true ? '开启中' : '未知') + ' · 常驻发送许可：' + (s.sendGrantValid ? '有效' : '无');
        $('batchPolicy').textContent = '连续消息合批：静默 ' + s.batchQuietMs / 1000 + ' 秒，最长等待 ' + s.batchMaxWaitMs / 1000 + ' 秒 · 用户记忆：' + (s.memoryEnabled ? '已启用' : '关闭') + ' · 消息正文保留 ' + s.retentionMinutes + ' 分钟';
        $('desktopHint').textContent = s.desktopMode === 'isolated' ? '小号运行在独立隐藏桌面，屏幕可以熄灭。锁屏期间继续只读收取消息，暂停生成回复、主动发言和界面操作，解锁后继续；发送结果不确定时仍需人工核对。电脑睡眠会暂停运行，请保持小号登录和目标会话选中。' : '请保持小号登录且选中目标会话。切换聊天与锁屏场景目前不支持。';
        $('counts').textContent = '缓存消息/去重记录 ' + s.receivedCount + ' 条 · 回复草稿 ' + s.draftCount + ' 批 · 保留的确认发送记录 ' + s.deliveredCount + ' 条' + (s.lastPollAt ? ' · 最近轮询 ' + s.lastPollAt : '');
        $('error').textContent = s.lastErrorCode ? '错误代码：' + s.lastErrorCode : '';
        renderUncertainAttempts(s);
        if (!initialized) { $('autoSend').checked = Boolean(s.autoSendEnabled); initialized = true; }
        $('autoSend').disabled = !s.sendConfigured;
        $('allowGate').disabled = !s.sendConfigured;
        if (!s.sendConfigured) $('allowGate').checked = false;
      } catch (error) { $('error').textContent = '状态读取失败：' + error.message; }
    }
    function renderUncertainAttempts(s) {
      const card = $('uncertainCard');
      const list = $('uncertainAttempts');
      const attempts = Array.isArray(s.uncertainAttempts) ? s.uncertainAttempts : [];
      const safeToAcknowledge = ['paused','error'].includes(s.phase) && s.runRequested === false &&
        s.workerBound === false && s.workerClosed === true && s.gateActive === false;
      const renderKey = JSON.stringify([safeToAcknowledge, attempts]);
      if (renderKey === uncertainRenderKey) return;
      uncertainRenderKey = renderKey;
      list.replaceChildren();
      card.hidden = attempts.length === 0;
      for (const [index, item] of attempts.entries()) {
        const row = document.createElement('div');
        row.className = 'card';
        const details = document.createElement('div');
        details.textContent = 'attemptId：' + item.attemptId + ' · 状态：' + item.status +
          ' · 诊断：' + item.reasonCode + ' · 已调用发送输入：' +
          (item.sendAttempted === true ? '是' : item.sendAttempted === false ? '否' : '未知');
        if (item.focusDiagnostic) {
          const d = item.focusDiagnostic;
          details.textContent += ' · 焦点监测：' + d.samples + '次采样，前台不可读' + d.zeroForegrounds +
            '次，窗口归属未知' + d.unknownOwners + '次，小号前台' + d.botForegrounds +
            '次，小号焦点事件' + d.botFocusEvents + '次，默认桌面' + (d.defaultDesktop ? '正常' : '异常') +
            (d.errors.length ? '，监测错误：' + d.errors.join('、') : '') +
            (d.failureReasons.length ? '，未通过项：' + d.failureReasons.join('、') : '');
        }
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = 'ack-confirm-' + index;
        checkbox.disabled = !safeToAcknowledge;
        const confirmation = document.createElement('span');
        confirmation.textContent = '我已人工核对微信，确认不重试这次发送，并同意永久跳过对应入站消息。';
        label.append(checkbox, confirmation);
        const button = document.createElement('button');
        button.className = 'secondary';
        button.textContent = '确认不重试并跳过此消息';
        button.disabled = true;
        checkbox.addEventListener('change', () => { button.disabled = !checkbox.checked; });
        button.addEventListener('click', async () => {
          if (!checkbox.checked || !window.confirm('这条消息将永久标记为跳过，不会补发，也不会自动启动监听。确认？')) return;
          button.disabled = true;
          try {
            await call('/wechat-bot/api/acknowledge','POST',{attemptId:item.attemptId,confirmedNoRetry:true});
            $('error').textContent = '已记录这次人工核对；旧消息已跳过。请手动开始监听后才会处理新消息。';
            await refresh();
          } catch (error) {
            $('error').textContent = '确认未完成：' + error.message;
            button.disabled = !checkbox.checked;
          }
        });
        row.append(details, label, button);
        if (!safeToAcknowledge) {
          const waiting = document.createElement('small');
          waiting.textContent = '需先暂停，并确认微信工作进程关闭、控件门已恢复。';
          row.append(waiting);
        }
        list.append(row);
      }
    }
    async function refreshDraft() {
      try { const r = await call('/wechat-bot/api/draft'); $('draft').textContent = r.draft ? r.draft.text : '尚无草稿'; }
      catch (error) { $('draft').textContent = '读取失败：' + error.message; }
    }
    $('start').onclick = async () => { try { await call('/wechat-bot/api/start','POST',{autoSend:false,allowTemporaryGate:false}); $('error').textContent=''; } catch(e) { $('error').textContent='启动失败：'+e.message; } await refresh(); };
    $('pause').onclick = async () => { try { await call('/wechat-bot/api/pause','POST',{}); $('error').textContent=''; } catch(e) { $('error').textContent='暂停未确认：'+e.message; } await refresh(); };
    $('startAuto').onclick = async () => { try { await call('/wechat-bot/api/start','POST',{autoSend:$('autoSend').checked,allowTemporaryGate:$('allowGate').checked}); $('error').textContent=''; } catch(e) { $('error').textContent='启动失败：'+e.message; } await refresh(); };
    $('revoke').onclick = async () => { try { await call('/wechat-bot/api/revoke','POST',{}); $('autoSend').checked=false; $('allowGate').checked=false; $('error').textContent=''; } catch(e) { $('error').textContent='撤销未确认：'+e.message; } await refresh(); };
    $('refreshDraft').onclick = refreshDraft;
    $('testModel').onclick = async () => { $('modelReply').textContent='请求中…'; try { const r=await call('/wechat-bot/api/test-model','POST',{}); $('modelReply').textContent=r.reply+'\\n模型：'+r.provider+' / '+r.model+'，reasoning '+r.reasoningEffort+'，finish '+r.finish+'；未发送微信。'; } catch(e) { $('modelReply').textContent='模型测试失败：'+e.message; } };
    $('shutdown').onclick = async () => {
      if (!window.confirm('将先关闭微信工作进程并释放状态锁，然后停止这个专用 DSH 实例。需要重新启动时运行 Start-DshBot.ps1。确定继续？')) return;
      $('shutdown').disabled = true;
      try {
        await call('/wechat-bot/api/shutdown','POST',{});
        $('error').textContent = '机器人已清理，DSH 正在正常停止。';
      } catch (e) {
        $('shutdown').disabled = false;
        $('error').textContent = '停止未确认：' + e.message;
      }
    };
    function updateConversationButton() {
      $('applyConversation').disabled = conversationBusy || hasUncertainSend || !selectedTargetId ||
        selectedTargetId === currentTargetId || !$('confirmConversation').checked;
    }
    function renderConversations() {
      const query = $('conversationSearch').value.trim().toLocaleLowerCase();
      const rows = conversationRows.filter(r => (r.name + ' ' + r.id).toLocaleLowerCase().includes(query));
      $('conversationList').replaceChildren();
      $('conversationCount').textContent = rows.length ? rows.length + ' 个会话' : '没有匹配的会话';
      for (const item of rows) {
        const label = document.createElement('label');
        label.className = 'conversation-option';
        const radio = document.createElement('input');
        radio.type = 'radio'; radio.name = 'conversation'; radio.value = item.id;
        radio.checked = item.id === selectedTargetId; radio.disabled = conversationBusy;
        radio.onchange = () => { selectedTargetId = item.id; updateConversationButton(); };
        const content = document.createElement('span');
        const name = document.createElement('strong');
        name.textContent = item.name + (item.id === currentTargetId ? ' · 当前' : '');
        const meta = document.createElement('small');
        meta.textContent = (item.type === 'group' ? '群聊' : '私聊') + ' · ' + item.id;
        content.append(name,meta); label.append(radio,content); $('conversationList').append(label);
      }
      updateConversationButton();
    }
    async function loadConversations() {
      conversationBusy = true; updateConversationButton();
      $('conversationCount').textContent = '正在读取BOT_ACCOUNT的会话…';
      $('conversationError').textContent = '';
      try {
        const result = await call('/wechat-bot/api/conversations');
        conversationRows = result.conversations; catalogCurrentId = result.currentId;
        renderConversations();
        if (hasUncertainSend) $('conversationError').textContent = '请先核对下方的未确认发送，再切换会话。';
      } catch(e) { $('conversationError').textContent = '读取失败：' + e.message; }
      finally { conversationBusy = false; renderConversations(); }
    }
    $('chooseConversation').onclick = async () => {
      selectedTargetId = currentTargetId; $('confirmConversation').checked = false;
      $('conversationSearch').value = ''; $('conversationDialog').showModal(); await loadConversations();
    };
    $('closeConversations').onclick = () => { if (!conversationBusy) $('conversationDialog').close(); };
    $('conversationDialog').oncancel = e => { if (conversationBusy) e.preventDefault(); };
    $('conversationSearch').oninput = renderConversations;
    $('confirmConversation').onchange = updateConversationButton;
    $('reloadConversations').onclick = () => { if (!conversationBusy) loadConversations(); };
    $('applyConversation').onclick = async () => {
      if ($('applyConversation').disabled) return;
      conversationBusy = true; updateConversationButton(); renderConversations();
      $('conversationError').textContent = '正在暂停旧监听并切换会话…';
      try {
        await call('/wechat-bot/api/conversations/select','POST',
          {targetId:selectedTargetId,currentId:catalogCurrentId,selectionConfirmed:true});
        initialized = false; $('allowGate').checked = false;
        $('conversationDialog').close(); await refresh(); await refreshDraft();
      } catch(e) {
        const hints = {send_recovery_required:'请先核对未确认的发送。',conversation_selection_stale:'当前会话已变化，请刷新列表。',
          conversation_selection_failed:'切换未通过核验。请检查会话是否在微信列表中、是否同名或有未发送草稿。',
          worker_error:'微信未完成切换。请检查目标是否在会话列表中、是否存在同名会话或草稿。'};
        $('conversationError').textContent = hints[e.message] || '切换失败：' + e.message;
        await refresh();
      } finally { conversationBusy = false; renderConversations(); }
    };
    refresh(); refreshDraft(); setInterval(refresh,5000);
  </script>
</body>
</html>`
}
