export function renderPage(nonce) {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>微信助手</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;font:15px/1.6 system-ui,sans-serif;background:#f4f7fb;color:#172033}
*{box-sizing:border-box}body{margin:0 auto;padding:24px;max-width:1080px}h1{font-size:1.4rem;margin:0 0 20px}h2{font-size:1rem;margin:0 0 12px}
.card{background:#fff;border:1px solid #dde4ef;border-radius:10px;padding:18px;margin:14px 0}.row{display:flex;align-items:center;justify-content:space-between;gap:16px}.muted{color:#65718a}#status{font-weight:600}#error,#conversationError{color:#c24141;white-space:pre-wrap;overflow-wrap:anywhere}#error:empty{display:none}
button{border:1px solid #bac7da;border-radius:7px;padding:8px 14px;background:#e8eef6;color:#24324a;font:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}button.primary{background:#1769aa;color:#fff}button:focus-visible,input:focus-visible,pre:focus-visible{outline:3px solid #70a9e8;outline-offset:2px}
#logs{font:13px/1.7 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;height:58vh;min-height:260px;margin:0;padding:14px;background:#f4f7fb;border-radius:6px}
dialog{width:min(620px,calc(100vw - 32px));max-height:85vh;padding:22px;border:1px solid #dde4ef;border-radius:12px;background:#fff;color:inherit}dialog::backdrop{background:#101a2a80}dialog h2{margin:0}#conversationSearch{width:100%;padding:10px 12px;border:1px solid #bac7da;border-radius:7px;font:inherit;margin:16px 0 8px;background:transparent;color:inherit}
#conversationList{max-height:38vh;overflow:auto;border-block:1px solid #dde4ef;padding:5px 0}.conversation-option{display:flex;gap:10px;align-items:flex-start;padding:10px;border-radius:6px;cursor:pointer}.conversation-option:has(input:checked){background:#e8f1fc}.conversation-option input{margin-top:6px}.conversation-option small{display:block;color:#65718a;overflow-wrap:anywhere}.dialog-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}#conversationError{min-height:1.6em;margin-top:8px}
@media(max-width:600px){body{padding:12px}.card{padding:14px}#logs{height:60vh}}
@media(prefers-color-scheme:dark){:root{background:#121722;color:#e5ebf5}.card,dialog{background:#1c2533;border-color:#344158}#logs{background:#121722}.muted,.conversation-option small{color:#aab6c8}button{background:#344158;color:#e5ebf5;border-color:#485974}.conversation-option:has(input:checked){background:#263e5c}#conversationList{border-color:#344158}#error,#conversationError{color:#ff9a9a}}
</style></head><body>
<h1>微信助手</h1>
<section class="card row"><div><h2>监听会话</h2><div id="selectedConversation" class="muted">正在读取…</div></div><button id="chooseConversation">选择会话</button></section>
<section class="card"><h2>连接状态</h2><div id="status" role="status">正在连接…</div><div id="detail" class="muted"></div><div id="error" role="alert"></div></section>
<section class="card"><h2>完整日志</h2><pre id="logs" tabindex="0" aria-label="完整运行日志">正在读取…</pre></section>
<dialog id="conversationDialog" aria-labelledby="conversationTitle">
<div class="row"><h2 id="conversationTitle">选择监听会话</h2><button id="closeConversations" aria-label="关闭会话选择">关闭</button></div>
<input id="conversationSearch" type="search" aria-label="搜索会话" placeholder="搜索群名、昵称或账号" autocomplete="off">
<div id="conversationCount" class="muted" role="status">正在读取…</div><div id="conversationList" role="radiogroup" aria-label="可选会话"></div>
<div id="conversationError" role="alert"></div><div class="dialog-footer"><button id="reloadConversations">刷新列表</button><button id="applyConversation" class="primary" disabled>切换并监听</button></div>
</dialog>
<script nonce="${nonce}">
const $=id=>document.getElementById(id);
let renewing=null;
async function call(path,method='GET',body){
  const options={method,credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined};
  let response=await fetch(path,options),data=await response.json();
  if(response.status===403 && data.error==='not_authorized'){
    if(!renewing) renewing=fetch('/wechat-bot/',{credentials:'same-origin',cache:'no-store'}).then(r=>{if(!r.ok)throw Error('not_authorized');}).finally(()=>{renewing=null;});
    await renewing;response=await fetch(path,options);data=await response.json();
  }
  if(!response.ok)throw Error(data.error||'request_failed');
  return data;
}
let currentTargetId=null,selectedTargetId=null,catalogCurrentId=null,conversationRows=[],conversationBusy=false,refreshing=false,logTarget=null,lastLogText='';
const time=at=>at&&Number.isFinite(Date.parse(at))?new Date(at).toLocaleString('zh-CN',{hour12:false}):'';
function renderLogs(result){
  const text=result.entries.map(e=>'['+time(e.at)+'] '+(e.level==='error'?'错误 · ':'')+e.title+(e.text?'\\n'+e.text:'')+(e.details?'\\n'+JSON.stringify(e.details,null,2):'')).join('\\n\\n')||'等待新消息…';
  const box=$('logs'),follow=logTarget!==result.targetId||box.scrollHeight-box.scrollTop-box.clientHeight<48;
  if(text!==lastLogText||logTarget!==result.targetId){box.textContent=text;lastLogText=text;logTarget=result.targetId;if(follow)box.scrollTop=box.scrollHeight;}
}
async function refresh(){
  if(refreshing)return;refreshing=true;
  try{
    const s=await call('/wechat-bot/api/status');currentTargetId=s.targetId;
    $('selectedConversation').textContent=(s.conversationType==='group'?'群聊 · ':'私聊 · ')+s.targetName;
    $('status').textContent=({running:'正在监听',starting:'正在连接',paused:'已暂停',stopped:'未启动',error:'监听异常'}[s.phase]||s.phase)+(s.waitingForDesktop?' · 等待解锁':s.workerBound?' · 微信已连接':'')+(s.running&&s.autoSendEnabled?' · 自动回复已开启':'');
    $('detail').textContent=s.botName+' → '+s.targetName+' · '+s.model+(s.lastPollAt?' · 最近收取 '+time(s.lastPollAt):'');
    $('error').textContent=s.lastErrorCode?'错误：'+s.lastErrorCode:'';updateConversationButton();
    const logs=await call('/wechat-bot/api/logs');if(logs.targetId===currentTargetId)renderLogs(logs);
  }catch(e){$('status').textContent='控制台连接中断';$('error').textContent=e.message;}finally{refreshing=false;}
}
function updateConversationButton(){$('applyConversation').disabled=conversationBusy||!selectedTargetId||selectedTargetId===currentTargetId;}
function renderConversations(){
  const query=$('conversationSearch').value.trim().toLocaleLowerCase(),rows=conversationRows.filter(r=>(r.name+' '+r.id).toLocaleLowerCase().includes(query));
  $('conversationList').replaceChildren();$('conversationCount').textContent=rows.length?rows.length+' 个会话':'没有匹配的会话';
  for(const item of rows){
    const label=document.createElement('label');label.className='conversation-option';
    const radio=document.createElement('input');radio.type='radio';radio.name='conversation';radio.value=item.id;radio.checked=item.id===selectedTargetId;radio.disabled=conversationBusy;
    radio.onchange=()=>{selectedTargetId=item.id;updateConversationButton();};
    const content=document.createElement('span'),name=document.createElement('strong'),meta=document.createElement('small');
    name.textContent=item.name+(item.id===currentTargetId?' · 当前':'');meta.textContent=(item.type==='group'?'群聊':'私聊')+' · '+item.id;
    content.append(name,meta);label.append(radio,content);$('conversationList').append(label);
  }updateConversationButton();
}
async function loadConversations(){
  conversationBusy=true;updateConversationButton();$('conversationError').textContent='';$('conversationCount').textContent='正在读取会话…';
  try{const r=await call('/wechat-bot/api/conversations');conversationRows=r.conversations;catalogCurrentId=r.currentId;}
  catch(e){$('conversationError').textContent='读取失败：'+e.message;}finally{conversationBusy=false;renderConversations();}
}
$('chooseConversation').onclick=async()=>{selectedTargetId=currentTargetId;$('conversationSearch').value='';$('conversationDialog').showModal();await loadConversations();};
$('closeConversations').onclick=()=>{if(!conversationBusy)$('conversationDialog').close();};
$('conversationDialog').oncancel=e=>{if(conversationBusy)e.preventDefault();};
$('conversationSearch').oninput=renderConversations;
$('reloadConversations').onclick=()=>{if(!conversationBusy)loadConversations();};
$('applyConversation').onclick=async()=>{
  if($('applyConversation').disabled)return;conversationBusy=true;renderConversations();$('conversationError').textContent='正在切换并启动监听…';
  try{await call('/wechat-bot/api/conversations/select','POST',{targetId:selectedTargetId,currentId:catalogCurrentId,selectionConfirmed:true});$('conversationDialog').close();await refresh();}
  catch(e){$('conversationError').textContent='切换失败：'+e.message;await refresh();}finally{conversationBusy=false;renderConversations();}
};
refresh();setInterval(refresh,3000);window.addEventListener('focus',refresh);
</script></body></html>`
}
