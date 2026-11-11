import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { z } from 'zod';
import { apply } from '../shared/domain.js';
const channelScopes = 'offline_access User.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function graphUrl(path) {
 const u = new URL(path, 'https://graph.microsoft.com/v1.0/');
 if (u.origin !== 'https://graph.microsoft.com' || !u.pathname.startsWith('/v1.0/')) throw fail('Invalid Graph pagination URL');
 return u.href;
}
export function importThreads(record, actor, users, team, channel, threads) {
 let imported=0, skipped=0;
 for (const thread of threads) {
  const sourceKey=JSON.stringify([team,channel,thread.id]);
  if(record.payload.raw.some(r=>r.source?.key===sourceKey)){skipped++;continue;}
  const messages=[thread,...(thread.replies||[])];
  const text=messages.map(m=>`[${m.createdDateTime || ''}] ${m.from?.user?.displayName || m.from?.application?.displayName || 'Unknown'}\n${m.body?.content || ''}`).join('\n\n');
  if(text.length>250000) throw fail('スレッドが大きすぎます。別のスレッドを選択してください。');
  const id=apply(record.payload,actor,users,'create',{text,consent:true});
  const card=record.payload.cards.find(c=>c.id===id); card.title=thread.subject || 'Teams の会話';
  const raw=record.payload.raw.find(r=>r.id===card.rawId);
  raw.source={provider:'teams',key:sourceKey,teamId:team,channelId:channel,messageId:thread.id,url:thread.webUrl,importedAt:new Date().toISOString(),messages};
  imported++;
 }
 return {imported,skipped};
}
export function installTeams(app,{db,demo,mutate}) {
 const memory=new WeakMap();
 const scopes = demo ? 'User.Read Chat.Read' : channelScopes;
 const env=process.env;
 const configured=!!(env.TEAMS_CLIENT_ID && env.TEAMS_CLIENT_SECRET && env.TEAMS_TENANT_ID && env.TEAMS_REDIRECT_URI && /^[a-f0-9]{64}$/i.test(env.TEAMS_TOKEN_KEY||''));
 const key=configured?Buffer.from(env.TEAMS_TOKEN_KEY,'hex'):null;
 const authority=`https://login.microsoftonline.com/${encodeURIComponent(env.TEAMS_TENANT_ID||'organizations')}/oauth2/v2.0`;
 const enc=value=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv); const data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');};
 const dec=value=>{const b=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]));};
 async function load(req){if(demo)return memory.get(req.demoSession)||{};const id=req.actor.id;const {data,error}=await db.from('teams_connections').select('secret').eq('user_id',id).maybeSingle();if(error)throw fail('Teams DB migration を適用してください。',503);return data?dec(data.secret):{};}
 async function save(req,value){if(demo){memory.set(req.demoSession,value);return;}const id=req.actor.id;const {error}=await db.from('teams_connections').upsert({user_id:id,secret:enc(value)});if(error)throw fail('Teams 接続情報を保存できません。',503);}
 async function token(params){const r=await fetch(authority+'/token',{method:'POST',body:new URLSearchParams({client_id:env.TEAMS_CLIENT_ID,client_secret:env.TEAMS_CLIENT_SECRET,scope:scopes,...params}),signal:AbortSignal.timeout(15000)});const t=await r.json();if(!r.ok)throw fail('Microsoft 認証に失敗しました。設定・同意を確認し、再接続してください。',400);return {...t,expires:Date.now()+t.expires_in*1000};}
 async function graph(req,path){let c=await load(req);if(!c.access_token)throw fail('Teams を接続してください。');if(c.expires<Date.now()+60000){if(demo)throw fail('接続の有効期限が切れました。Microsoft Teams に再接続してください。');const t=await token({grant_type:'refresh_token',refresh_token:c.refresh_token});c={...c,...t};await save(req,c);}const r=await fetch(graphUrl(path),{headers:{Authorization:'Bearer '+c.access_token},signal:AbortSignal.timeout(15000)});if(!r.ok)throw fail(r.status===429?'Microsoft の利用制限です。少し待って再試行してください。':'Teams の読み取りに失敗しました。権限または接続を確認してください。',r.status===429?429:400);return r.json();}
 const route=(method,path,fn)=>app[method]('/api/teams'+path,async(req,res,next)=>{try{res.set('Cache-Control','no-store');if(!configured && path!='/status')throw fail('Teams 環境変数を設定してください。',503);await fn(req,res);}catch(e){next(e);}});
 route('get','/status',async(req,res)=>{const c=configured?await load(req):{};res.json({configured,connected:!!c.access_token && (!demo || c.expires>Date.now()+60000),account:c.account,chatPreview:demo});});
 route('post','/connect',async(req,res)=>{const state=randomBytes(32).toString('hex'),verifier=randomBytes(32).toString('base64url');await save(req,{pending:{state,verifier,expires:Date.now()+600000}});res.json({url:authority+'/authorize?'+new URLSearchParams({client_id:env.TEAMS_CLIENT_ID,response_type:'code',redirect_uri:env.TEAMS_REDIRECT_URI,response_mode:'query',scope:scopes,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',prompt:'select_account'})});});
 route('post','/callback',async(req,res)=>{const input=z.object({code:z.string().max(10000),state:z.string().max(100)}).parse(req.body);const c=await load(req);if(!c.pending || c.pending.state!==input.state || c.pending.expires<Date.now())throw fail('接続要求が失効しました。再接続してください。');await save(req,{});const t=await token({grant_type:'authorization_code',code:input.code,redirect_uri:env.TEAMS_REDIRECT_URI,code_verifier:c.pending.verifier});await save(req,t);const me=await graph(req,'me');await save(req,{...t,account:me.displayName});res.json({ok:true});});
 route('post','/disconnect',async(req,res)=>{await save(req,{});res.json({ok:true});});
 if (demo) {
  async function preview(req,res,path) {
   const base = graphUrl(path);
   const cursor = req.query.next ? graphUrl(req.query.next) : base + '?$top=20';
   if (new URL(cursor).pathname !== new URL(base).pathname) throw fail('Invalid cursor');
   const result = await graph(req,cursor);
   res.json({value:result.value,next:result['@odata.nextLink'] || null});
  }
  route('get','/chats',(req,res)=>preview(req,res,'me/chats'));
  route('get','/chat-messages',(req,res)=>{
   const chat=z.string().min(1).max(500).parse(req.query.chat);
   return preview(req,res,'me/chats/'+encodeURIComponent(chat)+'/messages');
  });
  return;
 }
 route('get','/teams',async(req,res)=>{let url='me/joinedTeams',value=[];while(url){const d=await graph(req,url);value.push(...d.value);url=d['@odata.nextLink'];if(value.length>1000)throw fail('チーム数が上限を超えました。');}res.json({value});});
 const segment=s=>encodeURIComponent(z.string().min(1).max(500).parse(s));
 route('get','/channels',async(req,res)=>{let url=`teams/${segment(req.query.team)}/channels`,value=[];while(url){const d=await graph(req,url);value.push(...d.value);url=d['@odata.nextLink'];if(value.length>1000)throw fail('チャネル数が上限を超えました。');}res.json({value});});
 route('get','/messages',async(req,res)=>{const base=`teams/${segment(req.query.team)}/channels/${segment(req.query.channel)}/messages`;let url=req.query.next||base+'?$top=20';if(new URL(graphUrl(url)).pathname!==new URL(graphUrl(base)).pathname)throw fail('Invalid cursor');res.json(await graph(req,url));});
 route('post','/import',async(req,res)=>{if(req.actor.role==='viewer')throw fail('閲覧者はインポートできません。',403);const b=z.object({team:z.string().min(1).max(500),channel:z.string().min(1).max(500),ids:z.array(z.string().min(1).max(200)).min(1).max(10),consent:z.literal(true)}).parse(req.body);const threads=[];for(const id of new Set(b.ids)){const base=`teams/${segment(b.team)}/channels/${segment(b.channel)}/messages/${segment(id)}`;const thread=await graph(req,base);thread.replies=[];let url=base+'/replies?$top=50';while(url){const d=await graph(req,url);thread.replies.push(...d.value);url=d['@odata.nextLink'];if(thread.replies.length>1000)throw fail('返信が1000件を超えています。このスレッドは取り込めません。');}threads.push(thread);}res.json(await mutate(req,record=>importThreads(record,req.actor,req.users,b.team,b.channel,threads)));});
}
