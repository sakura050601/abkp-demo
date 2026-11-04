import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { z } from 'zod';
import { apply, demoUsers, seed, emptyState } from '../shared/domain.js';
import { authDatabaseError, installAuth } from './auth.js';
const demo = process.env.DEMO_MODE === 'true';
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!demo && (!url || !key)) throw new Error('Configure Supabase or explicitly set DEMO_MODE=true in .env');
const db = demo ? null : createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const app = express(), sessions = new Map();
app.set('trust proxy', 1);
app.use(helmet({ referrerPolicy: { policy: 'no-referrer' } })); app.use(cors({ origin: demo ? (process.env.CLIENT_ORIGIN || 'http://127.0.0.1:5173').split(',').map(s => s.trim()) : process.env.AUTH_ORIGIN, credentials: true }));
app.use('/api/auth', express.json({ limit: '32kb' })); app.use(express.json({ limit: '8mb' })); app.use('/api', rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false }));
app.get('/api/health', (_, res) => res.json({ ok: true, mode: demo ? 'demo' : 'supabase' }));
app.get('/api/config', (_, res) => res.json({ demo, authMode: demo ? 'demo' : 'passkey' }));
if (!demo) installAuth(app, db);
function createSession(session) {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { ...session, expires: Date.now() + 8 * 3600000 });
    return token;
}
app.post('/api/login', rateLimit({ windowMs: 60000, limit: 15 }), async (req, res, next) => {
    try {
        if (demo) {
            const user = demoUsers.find(u => u.id === req.body.userId);
            if (!user || req.body.password !== (process.env.DEMO_PASSWORD || 'knowledge-demo')) return res.status(401).json({ error: 'ログイン情報が違います。' });
            return res.json({ token: createSession({ user, project: 'demo' }) });
        }
        res.sendStatus(410);
    } catch (error) { next(error); }
});
app.post('/api/register', rateLimit({ windowMs: 60000, limit: 10 }), async (req, res, next) => {
    res.status(404).json({ error: '演示モードでは新規登録できません。' });
});
app.use('/api', async (req, res, next) => {
    try {
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const session = demo ? sessions.get(token) : req.authSession;
        if (!session || (demo ? session.expires < Date.now() : !session.user_id)) { if (demo) sessions.delete(token); return res.status(401).json({ error: 'ログインしてください。' }); }
        if (demo) { req.actor = session.user; req.project = 'demo'; req.users = demoUsers; }
        else {
            const { data: member, error: e } = await db.from('memberships').select('project_id,user_id,display_name,role').eq('user_id', session.user_id).eq('project_id', session.project_id).maybeSingle(); if (e) throw e;
            if (!member) return res.status(403).json({ error: 'プロジェクトへの登録がありません。管理者に確認してください。' });
            req.project = member.project_id; req.actor = { id: member.user_id, name: member.display_name, role: member.role };
            const { data: team, error: te } = await db.from('memberships').select('user_id,display_name,role').eq('project_id', req.project); if (te) throw te; req.users = team.map(u => ({ id: u.user_id, name: u.display_name, role: u.role }));
        }
        next();
    } catch (e) { next(e); }
});
const dataDir = resolve(process.env.DATA_DIR || '.data'); const path = join(dataDir, 'state.json'); let queue = Promise.resolve();
if (demo) { await mkdir(dataDir, { recursive: true }); try { await writeFile(path, JSON.stringify({ revision: 0, payload: seed() }), { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
async function read(project) {
    if (demo) { return JSON.parse(await readFile(path, 'utf8')); }
    const { data, error } = await db.from('project_states').select('revision,payload').eq('project_id', project).single(); if (error) throw error; return data;
}
async function save(project, record) {
    if (demo) { await writeFile(join(dataDir, 'state.tmp'), JSON.stringify(record)); await rename(join(dataDir, 'state.tmp'), path); return; }
    const { data, error } = await db.from('project_states').update(record).eq('project_id', project).eq('revision', record.revision - 1).select('revision'); if (error) throw error; if (!data.length) throw Object.assign(new Error('同時に更新されました。再読み込みしてください。'), { status: 409 });
}
app.post('/api/logout', (req, res) => { sessions.delete((req.headers.authorization || '').replace('Bearer ', '')); res.json({ ok: true }); });
app.get('/api/state', async (req, res, next) => { try { const record = await read(req.project); res.json({ ...record, user: req.actor, users: req.users, mode: demo ? 'demo' : 'supabase' }); } catch (e) { next(e); } });
app.post('/api/profile/role', async (req, res, next) => {
    try {
        if (demo) return res.status(404).json({ error: 'パスキー接続時のみ変更できます。' });
        const { role } = z.object({ role: z.enum(['designer', 'it']) }).strict().parse(req.body);
        const work = queue.then(async () => {
            const { error } = await db.rpc('auth_change_role', { p_session_hash: req.authSession.token_hash, p_role: role });
            if (error) throw Object.assign(new Error('本人確認をやり直してから役割を変更してください。'), { status: 403 });
        });
        queue = work.catch(() => { }); await work;
        res.json({ ok: true });
    } catch (error) { next(error); }
});
const file = z.object({ name: z.string().max(180), type: z.string().max(120), size: z.number().max(2 * 1024 * 1024), data: z.string().max(2800000).regex(/^data:[^;]*;base64,[A-Za-z0-9+/=]*$/) });
const schema = z.object({ command: z.enum(['create', 'submit', 'revise', 'decide', 'candidate']), revision: z.number().int().nonnegative(), payload: z.object({ id: z.string().max(80).optional(), version: z.number().int().optional(), text: z.string().max(50000).optional(), files: z.array(file).max(2).optional(), consent: z.boolean().optional(), problem: z.string().max(500).optional(), route: z.array(z.object({ type: z.enum(['review', 'final']), label: z.string().max(80), assignees: z.array(z.string().max(80)).max(2) })).max(8).optional(), decision: z.enum(['approve', 'return', 'reject']).optional(), reason: z.string().max(2000).optional(), importance: z.string().max(10).optional(), priority: z.string().max(5).optional(), category: z.string().max(10).optional() }) });
app.post('/api/commands', async (req, res, next) => {
    try {
        const input = schema.parse(req.body); const work = queue.then(async () => {
            if (!demo) {
                const { data: team, error } = await db.from('memberships').select('user_id,display_name,role').eq('project_id', req.project);
                if (error) throw error;
                req.users = team.map(member => ({ id: member.user_id, name: member.display_name, role: member.role }));
                const actor = req.users.find(member => member.id === req.actor.id);
                if (!actor) throw Object.assign(new Error('プロジェクトへのアクセス権がありません。'), { status: 403 });
                req.actor = actor;
            }
            const record = await read(req.project); if (record.revision !== input.revision) throw Object.assign(new Error('更新があります。再読み込みして操作し直してください。'), { status: 409 }); const id = apply(record.payload, req.actor, req.users, input.command, input.payload); record.revision++; await save(req.project, record); return { id };
        }); queue = work.catch(() => { }); res.json(await work);
    } catch (e) { next(e); }
});
if (!demo) {
    const { error, status } = await db.from('auth_sessions').select('token_hash').limit(1);
    if (error) throw authDatabaseError(error, status);
}
const clientDir = resolve('dist');
app.use(express.static(clientDir));
app.get(/^(?!\/api(?:\/|$)).*/, (_, res) => res.sendFile(join(clientDir, 'index.html')));
app.use((e, req, res, next) => { if (e instanceof z.ZodError) return res.status(400).json({ error: '入力形式またはファイルサイズが正しくありません。' }); const status = e.status || 500; if (status === 500) console.error('Request failed:', e.message); const code = ['SESSION_EXPIRED', 'CSRF_MISMATCH'].includes(e.code) ? e.code : undefined; res.status(status).json({ error: status === 500 ? '保存処理に失敗しました。設定を確認してください。' : e.message, ...(code ? { code } : {}) }); });
app.listen(Number(process.env.PORT) || 3001, '0.0.0.0', () => console.log('API ready: http://127.0.0.1:' + (process.env.PORT || 3001)));
