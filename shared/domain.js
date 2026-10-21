import { randomUUID } from 'node:crypto';
export const demoUsers=[{id:'author',name:'藤井 美咲',role:'designer'},{id:'reviewer',name:'田中 健一',role:'designer'},{id:'senior',name:'佐藤 直樹',role:'senior'},{id:'viewer',name:'山本 葵',role:'viewer'}];
export const sampleText='[01] 藤井：接続部の変更で周辺部品との干渉が心配です。\n[02] 田中：関連図面を洗い出して、組付けと工具の操作空間を確認しましょう。\n[03] 佐藤：単一部品の変更でも組付けに影響します。工具の種類と必要寸法は未確認です。';
export const emptyState=()=>({raw:[],cards:[],cores:[],events:[]});
const fail=(msg,status=400)=>{throw Object.assign(new Error(msg),{status});};
const event=(s,actor,action,id,detail='')=>s.events.unshift({id:randomUUID(),actor:actor.name,action,target:id,detail,time:new Date().toISOString()});
const person=(users,id)=>users.find(u=>u.id===id);
export function extract(text){
 const known=text.trim()===sampleText.trim();
 return {title:known?'接続部変更時の関連資料の確認':'新規資料の知識候補',problem:known?'変更の影響範囲':'未確認',conditions:known?'接続部の変更が周辺部品に影響する案件':'未確認',action:known?'関連図面を洗い出し、組付けと工具の操作空間を確認する。':'未確認',rationale:known?'単一部品の変更でも組付けに影響しうるため。':'未確認',limits:known?'工具の種類と必要寸法は未確認。責任者へ確認する。':'資料に基づく内容確認が必要です。',evidence:known?'発言 02–03':'提出資料（未検証）',claim:'unverified',resolved:known,simulation:true};
}
export function validateRoute(route,users){
 if(!Array.isArray(route)||route.length<3||route.length>8)fail('確認工程と最終承認者を設定してください。');
 const final=route.at(-1);
 if(final.type!=='final'||final.assignees.length!==2||new Set(final.assignees).size!==2)fail('最終入庫には異なる2名が必要です。');
 if(!final.assignees.some(id=>person(users,id)?.role==='senior'))fail('シニア設計者を含めてください。');
 for(const r of route){if(!r.label?.trim()||!r.assignees?.length||r.assignees.some(id=>!person(users,id)||person(users,id).role==='viewer'))fail('担当者が無効です。');}
 if(route.slice(0,-1).some(r=>r.type!=='review'||r.assignees.length!==1))fail('前工程は1名の確認者を指定してください。');
}
export function apply(s,actor,users,command,p){
 if(actor.role==='viewer')fail('閲覧者は変更できません。',403);
 if(command==='create'){
  if(!p.consent)fail('保存・利用許可の確認が必要です。');
  if(!p.text?.trim()&&!p.files?.length)fail('資料を追加してください。');
  const raw={id:'RAW-'+randomUUID().slice(0,8),owner:actor.id,text:p.text||'',files:p.files||[],revision:1,scope:'project',createdAt:new Date().toISOString()};
  const c={id:'KC-'+randomUUID().slice(0,8),rawId:raw.id,rawRevision:1,owner:actor.id,version:1,versions:[],...extract(raw.text),status:'draft',route:[],step:0,votes:[],importance:'重要',priority:'P2',category:'副知識',createdAt:raw.createdAt};
  s.raw.unshift(raw);s.cards.unshift(c);event(s,actor,'資料受領・候補生成',c.id,'デモ抽出');return c.id;
 }
 const c=s.cards.find(c=>c.id===p.id);if(!c)fail('カードが見つかりません。',404);
 if(p.version!==c.version)fail('版が更新されました。再読み込みしてください。',409);
 if(command==='candidate'){
  if(c.owner!==actor.id||c.status!=='draft')fail('草案の申請者のみ操作できます。',403);
  if(!['変更の影響範囲','図面の更新管理','hold'].includes(p.problem))fail('候補が無効です。');
  c.problem=p.problem;event(s,actor,p.problem==='hold'?'候補を保留':'候補を選択',c.id,p.problem);return c.id;
 }
 if(command==='submit'){
  if(c.owner!==actor.id)fail('申請者のみ操作できます。',403);
  if(c.status!=='draft')fail('申請可能な状態ではありません。');
  validateRoute(p.route,users);
  if(!p.problem||p.problem==='hold'||p.problem==='未確認'||!c.resolved)fail('未確認の候補は保留してください。資料を追加し、再確認が必要です。');
  c.problem=p.problem;c.claim='hypothesis';c.route=p.route;c.step=0;c.votes=[];c.status='review';event(s,actor,'承認申請',c.id);return c.id;
 }
 if(command==='revise'){
  if(c.owner!==actor.id||!['returned','core','draft'].includes(c.status))fail('このカードは改訂できません。',403);
  if(!p.text?.trim())fail('追加資料を入力してください。');
  c.versions.push(structuredClone({...c,versions:[]}));c.version++;c.status='draft';c.step=0;c.votes=[];
  const r=s.raw.find(r=>r.id===c.rawId);r.versions??=[];r.versions.push({revision:r.revision,text:r.text});r.revision++;r.text+='\n\n[追加資料 '+r.revision+']\n'+p.text;
  c.limits=p.text;c.rawRevision=r.revision;event(s,actor,'資料追加・新しい版',c.id,'v'+c.version);return c.id;
 }
 if(command!=='decide')fail('操作が無効です。');
 if(c.status!=='review')fail('審査中のカードではありません。');
 const step=c.route[c.step];if(!step.assignees.includes(actor.id))fail('この工程の担当者ではありません。',403);
 if(c.votes.includes(actor.id))fail('この版には既に承認済みです。',409);
 if(['return','reject'].includes(p.decision)){
  if(!p.reason?.trim())fail('理由を入力してください。');
  c.status=p.decision==='return'?'returned':'rejected';c.votes=[];event(s,actor,p.decision==='return'?'差戻し':'却下',c.id,p.reason);return c.id;
 }
 if(p.decision!=='approve')fail('判断が無効です。');
 if(step.type==='final'){
  if(!['重要','標準','参考'].includes(p.importance)||!['P1','P2','P3'].includes(p.priority)||!['主知識','副知識'].includes(p.category))fail('選定基準を選択してください。');
  const terms={importance:p.importance,priority:p.priority,category:p.category};
  if(c.votes.length&&Object.keys(terms).some(k=>terms[k]!==c[k]))fail('先の承認者と同じ選定基準への合意が必要です。');
  Object.assign(c,terms);c.votes.push(actor.id);event(s,actor,'最終承認',c.id,`v${c.version} / ${c.votes.length}/2`);
  if(c.votes.length===2){c.status='core';s.cores.unshift({id:'CORE-'+randomUUID().slice(0,8),cardId:c.id,approvedVersion:c.version,snapshot:structuredClone(c),approvers:[...c.votes],approvedAt:new Date().toISOString()});event(s,actor,'コアDB登録',c.id);}
 }else{c.step++;c.votes=[];event(s,actor,step.label+' 承認',c.id);}
 return c.id;
}
export function seed(){const s=emptyState();const id=apply(s,demoUsers[0],demoUsers,'create',{text:sampleText,consent:true});const c=s.cards[0];c.title='接続部変更時の関連資料の確認';return s;}
