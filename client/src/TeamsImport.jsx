import React,{useEffect,useState} from 'react';
export default function TeamsImport({request,refresh,user}){
 const [status,S]=useState(null),[teams,T]=useState([]),[channels,C]=useState([]),[team,ST]=useState(''),[channel,SC]=useState(''),[messages,M]=useState([]),[next,N]=useState(null),[ids,I]=useState([]),[consent,A]=useState(false),[busy,B]=useState(false),[note,E]=useState('');
 const post=(path,body={})=>request('/teams/'+path,{method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(180000)});
 async function run(fn){B(true);E('');try{await fn();}catch(e){E(e.message);}finally{B(false);}}
 async function init(){const s=await request('/teams/status');S(s);if(s.connected && !s.chatPreview)T((await request('/teams/teams')).value);}
 useEffect(()=>{run(async()=>{const q=new URLSearchParams(location.search);if(q.has('state')){history.replaceState(null,'',location.pathname);try{if(q.has('error'))throw new Error('Microsoft 接続がキャンセルされたか、許可されませんでした。');await post('callback',{code:q.get('code'),state:q.get('state')});}catch(error){await init();throw error;}return init();}await init();});},[]);
 async function messagesPage(cursor){const d=await request('/teams/messages?'+new URLSearchParams({team,channel,...(cursor?{next:cursor}:{})}));M(old=>cursor?[...old,...d.value]:d.value);N(d['@odata.nextLink']||null);}
 if (status?.chatPreview) return <ChatPreview status={status} busy={busy} note={note} run={run} post={post} init={init} request={request} />;
 return <section className="platform-integration"><h4>Teams からインポート</h4><p>チャネルの投稿と返信を原資料・草案として取り込みます。添付ファイル本体と個人チャットは対象外です。</p>{note&&<p role="status" className="alert">{note}</p>}{!status?<p>接続を確認中…</p>:!status.configured?<p>Teams は準備中です。接続できるようになったら、ここから Microsoft アカウントでサインインできます。</p>:<><p>{status.connected?'接続済み：'+(status.account||'Microsoft Teams'):'未接続'}</p><button disabled={busy} onClick={()=>run(async()=>{location.assign((await post('connect')).url);})}>Microsoft Teams を接続</button>{status.connected&&<><button disabled={busy} onClick={()=>run(async()=>{await post('disconnect');T([]);C([]);M([]);I([]);await init();})}>接続解除</button><label>チーム<select disabled={busy} value={team} onChange={e=>{const v=e.target.value;ST(v);SC('');C([]);M([]);I([]);N(null);if(v)run(async()=>C((await request('/teams/channels?team='+encodeURIComponent(v))).value));}}><option value="">選択してください</option>{teams.map(t=><option key={t.id} value={t.id}>{t.displayName}</option>)}</select></label><label>チャネル<select disabled={busy} value={channel} onChange={e=>{SC(e.target.value);M([]);I([]);N(null);}}><option value="">選択してください</option>{channels.map(c=><option key={c.id} value={c.id}>{c.displayName}</option>)}</select></label><button disabled={busy||!channel} onClick={()=>run(()=>messagesPage())}>投稿を読み込む</button><p>一度に最大10スレッド。再取り込み時は登録済みスレッドをスキップします。</p>{messages.map(m=><label key={m.id} style={{display:'block',padding:12,borderBottom:'1px solid #ddd'}}><input type="checkbox" disabled={busy||(!ids.includes(m.id)&&ids.length>=10)} checked={ids.includes(m.id)} onChange={e=>I(e.target.checked?[...ids,m.id]:ids.filter(id=>id!==m.id))}/><b>{m.from?.user?.displayName||'Unknown'} · {m.createdDateTime}</b><pre style={{whiteSpace:'pre-wrap',maxHeight:150,overflow:'auto'}}>{m.body?.content}</pre></label>)}{next&&<button disabled={busy} onClick={()=>run(()=>messagesPage(next))}>さらに読み込む</button>}<label style={{display:'block'}}><input type="checkbox" checked={consent} onChange={e=>A(e.target.checked)}/>この会話を案件メンバーに共有・保存する許可があります。</label><button className="primary" disabled={busy||!consent||!ids.length||user.role==='viewer'} onClick={()=>run(async()=>{const r=await post('import',{team,channel,ids,consent});await refresh();I([]);E(`取り込み ${r.imported} 件 / 登録済み ${r.skipped} 件`);})}>{busy?'処理中…':`選択した ${ids.length} 件を取り込む`}</button></>}</>}</section>;
}

function ChatPreview({status,busy,note,run,post,init,request}) {
 const [chats,setChats]=useState([]);
 const [chat,setChat]=useState('');
 const [messages,setMessages]=useState([]);
 const [chatCursor,setChatCursor]=useState(null);
 const [messageCursor,setMessageCursor]=useState(null);
 async function loadChats(next) {
  const result=await request('/teams/chats'+(next?'?'+new URLSearchParams({next}):''));
  setChats(current=>next?[...current,...result.value]:result.value);
  setChatCursor(result.next);
 }
 async function loadMessages(id,next) {
  const result=await request('/teams/chat-messages?'+new URLSearchParams({chat:id,...(next?{next}:{})}));
  setMessages(current=>next?[...current,...result.value]:result.value);
  setMessageCursor(result.next);
 }
 return <section className="platform-integration">
  <h4>Teams チャットのプレビュー</h4>
  <p>参加しているチャットを読み取り専用で表示します。メッセージは保存されません。</p>
  {note && <p role="status" className="alert">{note}</p>}
  {!status.configured ? <p>Teams 接続の設定を確認してください。</p> :
   <button className="primary" disabled={busy} onClick={()=>run(async()=>location.assign((await post('connect')).url))}>Microsoft Teams を接続</button>}
  {status.connected && <>
   <p>接続済み：{status.account || 'Microsoft Teams'}</p>
   <button disabled={busy} onClick={()=>run(async()=>{await post('disconnect');setChats([]);setChat('');setMessages([]);setChatCursor(null);setMessageCursor(null);await init();})}>接続解除</button>
   <button disabled={busy} onClick={()=>run(()=>loadChats())}>チャットを読み込む</button>
   {chatCursor && <button disabled={busy} onClick={()=>run(()=>loadChats(chatCursor))}>さらにチャットを読み込む</button>}
   {chats.length>0 && <label>チャット<select value={chat} disabled={busy} onChange={e=>{
    const id=e.target.value;setChat(id);setMessages([]);setMessageCursor(null);
    if(id)run(()=>loadMessages(id));
   }}><option value="">選択してください</option>{chats.map((item,index)=><option key={item.id} value={item.id}>{item.topic || (item.chatType==='oneOnOne'?'個人チャット':'グループチャット')+' '+(index+1)}</option>)}</select></label>}
   {messages.map(message=><article key={message.id}><b>{message.from?.user?.displayName || 'Teams'} · {message.createdDateTime}</b><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{message.body?.content}</pre></article>)}
   {messageCursor && <button disabled={busy} onClick={()=>run(()=>loadMessages(chat,messageCursor))}>さらにメッセージを読み込む</button>}
  </>}
 </section>;
}
