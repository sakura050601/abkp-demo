import { randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { createMailer } from './email.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const companyEmail = z.string().trim().email().max(254).transform(email => email.toLowerCase()).refine(email => email.endsWith('@abist.co.jp'), { message: 'Only @abist.co.jp company email addresses are allowed.' });
export function authDatabaseError(error, status) {
    const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,24}$/.test(error.code) ? error.code : 'unknown';
    const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 'unknown';
    const hint = ['PGRST205', '42P01'].includes(code) ? 'public.auth_sessions is missing from this project or its API schema cache; apply the full supabase/schema.sql to the project configured in Render.'
        : code === '42501' || [401, 403].includes(httpStatus) ? 'Check the server-only Supabase key, project URL and service_role table grants. Never use an anon or publishable key.'
            : 'Check Supabase project availability, API configuration and server credentials.';
    return new Error(`Authentication database unavailable [HTTP ${httpStatus}; code ${code}]. ${hint}`);
}
const secret = () => randomBytes(32).toString('base64url');
const failure = (status = 400, message = '認証を完了できません。最初からやり直してください。', code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const grantInput = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(), name: z.string().trim().min(1).max(60).default('パスキー') });
const responseInput = z.object({ id: z.uuid(), response: z.object({ id: z.string().min(1).max(2048) }).passthrough() });
const result = async query => { const { data, error } = await query; if (error) throw error.code === 'P0001' ? failure(409, '認証情報が変更されたか、操作を完了できません。ログインし直して確認してください。') : error; return data; };

export function authConfig(env = process.env) {
    if (!env.AUTH_ORIGIN) throw new Error('AUTH_ORIGIN is required for passkey authentication');
    const origin = new URL(env.AUTH_ORIGIN);
    const local = ['localhost', '127.0.0.1'].includes(origin.hostname);
    if (origin.origin !== env.AUTH_ORIGIN || origin.username || origin.password || (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:' && env.NODE_ENV !== 'production'))) throw new Error('AUTH_ORIGIN must be a fixed HTTPS origin (HTTP loopback is development-only)');
    const rpID = env.WEBAUTHN_RP_ID || origin.hostname;
    if (rpID !== origin.hostname) throw new Error('WEBAUTHN_RP_ID must equal the AUTH_ORIGIN hostname');
    return { origin: origin.origin, rpID, secure: origin.protocol === 'https:', cookieName: origin.protocol === 'https:' ? '__Host-kp-session' : 'kp-session' };
}

export function installAuth(app, db) {
    const config = authConfig();
    const mailer = createMailer(config.origin);
    const cookieOptions = { httpOnly: true, secure: config.secure, sameSite: 'lax', path: '/' };
    let cleanupAfter = 0;
    function scheduleCleanup(res) {
        if (Date.now() < cleanupAfter) return;
        cleanupAfter = Date.now() + 900000;
        res.once('finish', () => {
            const now = new Date().toISOString();
            (async () => {
                await result(db.from('auth_challenges').delete().lt('expires_at', now));
                await result(db.from('auth_grants').delete().lt('expires_at', now));
                await result(db.from('auth_sessions').delete().lt('expires_at', now));
            })().catch(() => console.warn('Expired authentication record cleanup will retry later.'));
        });
    }
    function tokenFrom(req) {
        const values = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(config.cookieName + '='));
        return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0].slice(config.cookieName.length + 1)) ? values[0].slice(config.cookieName.length + 1) : null;
    }
    async function sessionFor(req) {
        const token = tokenFrom(req);
        if (!token) return null;
        const session = await result(db.from('auth_sessions').select('*,app_users(auth_version)').eq('token_hash', digest(token)).gt('expires_at', new Date().toISOString()).maybeSingle());
        if (session?.user_id && (!session.app_users || session.app_users.auth_version !== session.auth_version)) return null;
        return session;
    }
    async function issueSession(res, context, credential) {
        const token = secret(), csrf = secret();
        await result(db.rpc('auth_complete', { p_context: context, p_credential: credential, p_new_token_hash: digest(token), p_csrf_token: csrf }));
        res.cookie(config.cookieName, token, { ...cookieOptions, maxAge: 8 * 3600000 });
        res.json({ ok: true, csrfToken: csrf, userId: context.user_id, authenticated: true, expiresAt: new Date(Date.now() + 8 * 3600000).toISOString() });
    }
    const recent = session => {
        if (!session?.user_id || !session.authenticated_at || Date.parse(session.authenticated_at) < Date.now() - 300000) throw failure(401, 'ログインし直してから操作してください。');
    };
    const authLimit = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '試行回数が多すぎます。しばらく待ってください。' } });
    app.use('/api', async (req, res, next) => {
        try {
            res.set('Cache-Control', 'no-store');
            if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
                if (req.headers.origin !== config.origin || !req.is('application/json')) throw failure(403, '送信元を確認できません。');
            }
            req.authSession = await sessionFor(req);
            if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
                if (!req.authSession) throw failure(401, '認証の有効期限が切れました。ログインまたはメール確認をやり直してください。', 'SESSION_EXPIRED');
                if (!same(req.headers['x-csrf-token'], req.authSession.csrf_token)) throw failure(403, '認証情報の同期が必要です。もう一度お試しください。', 'CSRF_MISMATCH');
            }
            next();
        } catch (error) { next(error); }
    });
    app.get('/api/auth/session', authLimit, async (req, res, next) => {
        try {
            let session = req.authSession;
            if (!session) {
                const token = secret();
                session = { token_hash: digest(token), csrf_token: secret(), expires_at: new Date(Date.now() + 600000).toISOString() };
                await result(db.from('auth_sessions').insert(session));
                res.cookie(config.cookieName, token, { ...cookieOptions, maxAge: 600000 });
            }
            scheduleCleanup(res);
            res.json({ csrfToken: session.csrf_token, authenticated: !!session.user_id, userId: session.user_id || null, expiresAt: session.expires_at });
        } catch (error) { next(error); }
    });
    app.use('/api/auth', authLimit);
    app.post('/api/auth/signup/request', rateLimit({ windowMs: 900000, limit: 20, message: { error: '送信回数が多すぎます。しばらく待ってください。' } }), async (req, res, next) => {
        try {
            const input = z.object({ email: companyEmail, nickname: z.string().trim().min(1).max(60) }).parse(req.body);
            if (!mailer.ready) throw failure(503, 'メール確認の準備ができていません。しばらくしてからお試しください。');
            if (req.authSession.user_id) throw failure(409, 'ログアウトしてから登録してください。');
            const id = randomUUID(), code = String(randomInt(100000000)).padStart(8, '0');
            const status = await result(db.rpc('auth_request_email', { p_id: id, p_email: input.email, p_nickname: input.nickname, p_session_hash: req.authSession.token_hash, p_code_hash: mailer.hash(id, code) }));
            if (status === 'limited') throw failure(429, '送信上限に達しました。再送は60秒以上待ってからお試しください。');
            if (status !== 'ok') throw failure(503, 'ワークスペースの準備ができていません。');
            try { await mailer.sendCode(input.email, code); } catch {
                await result(db.from('auth_email_codes').update({ consumed: true }).eq('id', id));
                throw failure(503, '確認メールを送信できませんでした。時間をおいて再度お試しください。');
            }
            res.cookie(config.cookieName, tokenFrom(req), { ...cookieOptions, maxAge: 600000 });
            res.json({ id, email: input.email });
        } catch (error) { next(error); }
    });
    app.post('/api/auth/signup/verify', async (req, res, next) => {
        try {
            const input = z.object({ id: z.uuid(), code: z.string().regex(/^\d{8}$/) }).parse(req.body);
            if (!mailer.ready) throw failure(503, 'メール確認の準備ができていません。');
            const token = secret();
            const status = await result(db.rpc('auth_verify_email', { p_id: input.id, p_session_hash: req.authSession.token_hash, p_code_hash: mailer.hash(input.id, input.code), p_grant_hash: digest(token) }));
            if (status === 'exists') throw failure(409, 'このメールアドレスは登録済みです。パスキーでログインしてください。');
            if (status !== 'verified') throw failure(400, 'コードが違うか、有効期限が切れています。再送してやり直してください。');
            res.cookie(config.cookieName, tokenFrom(req), { ...cookieOptions, maxAge: 600000 });
            res.json({ token });
        } catch (error) { next(error); }
    });
    async function saveChallenge(req, options, context) {
        await result(db.from('auth_challenges').delete().eq('session_hash', req.authSession.token_hash));
        const challenge = await result(db.from('auth_challenges').insert({ ...context, session_hash: req.authSession.token_hash, challenge: options.challenge, expires_at: new Date(Date.now() + 300000).toISOString() }).select('id').single());
        return { id: challenge.id, options };
    }
    async function consumeChallenge(req, id, registration) {
        const context = await result(db.from('auth_challenges').delete().eq('id', id).eq('session_hash', req.authSession.token_hash).gt('expires_at', new Date().toISOString()).select('*').maybeSingle());
        if (!context || (registration ? !['enroll', 'add'].includes(context.kind) : context.kind !== 'login')) throw failure();
        return context;
    }
    app.post('/api/auth/register/options', async (req, res, next) => {
        try {
            const input = grantInput.parse(req.body);
            let userId, grantHash, kind;
            if (input.token) {
                grantHash = digest(input.token);
                const grant = await result(db.from('auth_grants').select('user_id,session_hash').eq('token_hash', grantHash).gt('expires_at', new Date().toISOString()).maybeSingle());
                if (!grant || (grant.session_hash && grant.session_hash !== req.authSession.token_hash)) throw failure();
                userId = grant.user_id; kind = 'enroll';
            } else { recent(req.authSession); userId = req.authSession.user_id; kind = 'add'; }
            const user = await result(db.from('app_users').select('id,email,nickname,auth_version').eq('id', userId).single());
            if (kind === 'enroll' && !companyEmail.safeParse(user.email).success) throw failure(403, '登録には @abist.co.jp の会社メールアドレスへの招待が必要です。管理者に確認してください。');
            const keys = await result(db.from('auth_passkeys').select('id,transports').eq('user_id', userId));
            if ((kind === 'enroll' && keys.length) || keys.length >= 10) throw failure();
            const options = await generateRegistrationOptions({ rpName: '設計ナレッジ', rpID: config.rpID, userID: new Uint8Array(Buffer.from(user.id)), userName: user.email, userDisplayName: user.nickname, attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: keys.map(key => ({ id: key.id, transports: key.transports })) });
            res.json(await saveChallenge(req, options, { kind, user_id: user.id, auth_version: user.auth_version, grant_hash: grantHash || null, name: input.name }));
        } catch (error) { next(error); }
    });
    app.post('/api/auth/register/verify', async (req, res, next) => {
        try {
            const input = responseInput.parse(req.body);
            const context = await consumeChallenge(req, input.id, true);
            let verification;
            try { verification = await verifyRegistrationResponse({ response: input.response, expectedChallenge: context.challenge, expectedOrigin: config.origin, expectedRPID: config.rpID, requireUserVerification: true }); } catch { throw failure(); }
            if (!verification.verified) throw failure();
            const credential = verification.registrationInfo.credential;
            await issueSession(res, context, { id: credential.id, public_key: Buffer.from(credential.publicKey).toString('base64url'), counter: credential.counter, transports: credential.transports || [] });
        } catch (error) { next(error); }
    });
    app.post('/api/auth/login/options', async (req, res, next) => {
        try {
            const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: 'required' });
            res.json(await saveChallenge(req, options, { kind: 'login' }));
        } catch (error) { next(error); }
    });
    app.post('/api/auth/login/verify', async (req, res, next) => {
        try {
            const input = responseInput.parse(req.body);
            const context = await consumeChallenge(req, input.id, false);
            const key = await result(db.from('auth_passkeys').select('*').eq('id', input.response.id).maybeSingle());
            if (!key || input.response.response?.userHandle !== Buffer.from(key.user_id).toString('base64url')) throw failure();
            const user = await result(db.from('app_users').select('auth_version').eq('id', key.user_id).single());
            let verification;
            try { verification = await verifyAuthenticationResponse({ response: input.response, expectedChallenge: context.challenge, expectedOrigin: config.origin, expectedRPID: config.rpID, requireUserVerification: true, credential: { id: key.id, publicKey: new Uint8Array(Buffer.from(key.public_key, 'base64url')), counter: Number(key.counter), transports: key.transports } }); } catch { throw failure(); }
            if (!verification.verified) throw failure();
            await issueSession(res, { ...context, user_id: key.user_id, auth_version: user.auth_version }, { id: key.id, counter: verification.authenticationInfo.newCounter, previous_counter: key.counter });
        } catch (error) { next(error); }
    });
    app.post('/api/login', (_, res) => res.status(410).json({ error: 'パスキーでログインしてください。' }));
    app.post('/api/register', (_, res) => res.status(410).json({ error: '登録には管理者からの招待が必要です。' }));
    app.post(['/api/auth/logout', '/api/logout'], async (req, res, next) => {
        try {
            await result(db.from('auth_sessions').delete().eq('token_hash', req.authSession.token_hash));
            res.clearCookie(config.cookieName, cookieOptions); res.json({ ok: true });
        } catch (error) { next(error); }
    });
    app.get('/api/auth/passkeys', async (req, res, next) => {
        try {
            if (!req.authSession?.user_id) throw failure(401, 'ログインしてください。');
            res.json({ passkeys: await result(db.from('auth_passkeys').select('id,name,created_at').eq('user_id', req.authSession.user_id).order('created_at')) });
        } catch (error) { next(error); }
    });
    app.post('/api/auth/passkeys/remove', async (req, res, next) => {
        try {
            recent(req.authSession);
            const { id } = z.object({ id: z.string().min(1).max(2048) }).parse(req.body);
            await result(db.rpc('auth_remove_passkey', { p_session_hash: req.authSession.token_hash, p_credential_id: id }));
            res.json({ ok: true });
        } catch (error) { next(error); }
    });
}