import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import {createClient} from '@supabase/supabase-js';
import {randomBytes} from 'node:crypto';
import {resolve,join} from 'node:path';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {z} from 'zod';
import {apply,demoUsers,seed,emptyState} from '../shared/domain.js';
const demo=process.env.DEMO_MODE==='true';
const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!demo&&(!url||!key||!process.env.SUPABASE_ANON_KEY))throw new Error('Configure Supabase or explicitly set DEMO_MODE=true in .env');
const db=demo?null:createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const app=express(),sessions=new Map();
app.set('trust proxy',1);
app.use(helmet());app.use(cors({origin:(process.env.CLIENT_ORIGIN||'http://127.0.0.1:5173').split(',').map(s=>s.trim())}));
app.use(express.json({limit:'8mb'}));app.use('/api',rateLimit({windowMs:60000,limit:180,standardHeaders:'draft-8',legacyHeaders:false}));
app.get('/api/health',(_,res)=>res.json({ok:true,mode:demo?'demo':'supabase'}));
app.get('/api/config',(_,res)=>res.json({demo,supabaseUrl:demo?null:url,supabaseAnonKey:demo?null:process.env.SUPABASE_ANON_KEY}));
app.post('/api/login',rateLimit({windowMs:60000,limit:15}), (req,res)=>{
 if(!demo)return res.status(404).json({error:'Not available'});
 const u=demoUsers.find(u=>u.id===req.body.userId);
 if(!u||req.body.password!==(process.env.DEMO_PASSWORD||'knowledge-demo'))return res.status(401).json({error:'ログイン情報が違います。'});
 const token=randomBytes(32).toString('hex');sessions.set(token,{user:u,expires:Date.now()+8*3600000});res.json({token});
});
app.use('/api',async(req,res,next)=>{try{
 const token=(req.headers.authorization||'').replace(/^Bearer /,'');
 if(demo){const session=sessions.get(token);if(!session||session.expires<Date.now())return res.status(401).json({error:'ログインしてください。'});req.actor=session.user;req.project='demo';req.users=demoUsers;}
 else{const {data,error}=await db.auth.getUser(token);if(error||!data.user)return res.status(401).json({error:'認証が必要です。'});
 const {data:members,error:e}=await db.from('memberships').select('*').eq('user_id',data.user.id).order('created_at').limit(1);if(e)throw e;
 const member=members?.[0];if(!member)return res.status(403).json({error:'プロジェクトへの招待が必要です。'});
 req.project=member.project_id;req.actor={id:member.user_id,name:member.display_name,role:member.role};
 const {data:team,error:te}=await db.from('memberships').select('user_id,display_name,role').eq('project_id',req.project);if(te)throw te;req.users=team.map(u=>({id:u.user_id,name:u.display_name,role:u.role}));}
 next();
 }catch(e){next(e);}});
const dataDir=resolve(process.env.DATA_DIR||'.data');const path=join(dataDir,'state.json');let queue=Promise.resolve();
if(demo){await mkdir(dataDir,{recursive:true});try{await writeFile(path,JSON.stringify({revision:0,payload:seed()}),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}}
async function read(project){if(demo){return JSON.parse(await readFile(path,'utf8'));}
 const {data,error}=await db.from('project_states').select('revision,payload').eq('project_id',project).single();if(error)throw error;return data;}
async function save(project,record){if(demo){await writeFile(join(dataDir,'state.tmp'),JSON.stringify(record));await rename(join(dataDir,'state.tmp'),path);return;}
 const {data,error}=await db.from('project_states').update(record).eq('project_id',project).eq('revision',record.revision-1).select('revision');if(error)throw error;if(!data.length)throw Object.assign(new Error('同時に更新されました。再読み込みしてください。'),{status:409});}
app.post('/api/logout',(req,res)=>{sessions.delete((req.headers.authorization||'').replace('Bearer ',''));res.json({ok:true});});
app.get('/api/state',async(req,res,next)=>{try{const record=await read(req.project);res.json({...record,user:req.actor,users:req.users,mode:demo?'demo':'supabase'});}catch(e){next(e);}});
const file=z.object({name:z.string().max(180),type:z.string().max(120),size:z.number().max(2*1024*1024),data:z.string().max(2800000).regex(/^data:[^;]*;base64,[A-Za-z0-9+/=]*$/)});
const schema=z.object({command:z.enum(['create','submit','revise','decide','candidate']),revision:z.number().int().nonnegative(),payload:z.object({id:z.string().max(80).optional(),version:z.number().int().optional(),text:z.string().max(50000).optional(),files:z.array(file).max(2).optional(),consent:z.boolean().optional(),problem:z.string().max(500).optional(),route:z.array(z.object({type:z.enum(['review','final']),label:z.string().max(80),assignees:z.array(z.string().max(80)).max(2)})).max(8).optional(),decision:z.enum(['approve','return','reject']).optional(),reason:z.string().max(2000).optional(),importance:z.string().max(10).optional(),priority:z.string().max(5).optional(),category:z.string().max(10).optional()})});
app.post('/api/commands',async(req,res,next)=>{try{const input=schema.parse(req.body);const work=queue.then(async()=>{const record=await read(req.project);if(record.revision!==input.revision)throw Object.assign(new Error('更新があります。再読み込みして操作し直してください。'),{status:409});const id=apply(record.payload,req.actor,req.users,input.command,input.payload);record.revision++;await save(req.project,record);return {id};});queue=work.catch(()=>{});res.json(await work);}catch(e){next(e);}});
app.use((e,req,res,next)=>{if(e instanceof z.ZodError)return res.status(400).json({error:'入力形式またはファイルサイズが正しくありません。'});const status=e.status||500;if(status===500)console.error('Request failed:',e.message);res.status(status).json({error:status===500?'保存処理に失敗しました。設定を確認してください。':e.message});});
app.listen(Number(process.env.PORT)||3001,'0.0.0.0',()=>console.log('API ready: http://127.0.0.1:'+(process.env.PORT||3001)));
