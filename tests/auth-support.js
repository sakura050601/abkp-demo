import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { randomBytes, generateKeyPairSync, createHash, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { companyEmail, digest } from '../server/auth.js';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const identifier = value => { if (!/^[a-z_]+$/.test(value)) throw new Error('Invalid test SQL identifier'); return `"${value}"`; };
const hash = value => createHash('sha256').update(value).digest();
const base64 = value => Buffer.from(value).toString('base64url');

export function authenticator() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const id = randomBytes(32);
    const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]]));
    let userHandle, counter = 0;
    function clientData(type, options, origin) { return Buffer.from(JSON.stringify({ type, challenge: options.challenge, origin, crossOrigin: false })); }
    return {
        id: base64(id),
        register(options, origin, { uv = true, rpID = options.rp.id } = {}) {
            userHandle = options.user.id;
            const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
            const authData = Buffer.concat([hash(rpID), Buffer.from([uv ? 0x45 : 0x41]), Buffer.alloc(4), Buffer.alloc(16), length, id, Buffer.from(cose)]);
            return { id: base64(id), rawId: base64(id), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: base64(clientData('webauthn.create', options, origin)), attestationObject: base64(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]))), transports: ['internal'] } };
        },
        login(options, origin, { uv = true, rpID = options.rpId, handle = userHandle } = {}) {
            const count = Buffer.alloc(4); count.writeUInt32BE(++counter);
            const authData = Buffer.concat([hash(rpID), Buffer.from([uv ? 0x05 : 0x01]), count]);
            const client = clientData('webauthn.get', options, origin);
            return { id: base64(id), rawId: base64(id), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: base64(client), authenticatorData: base64(authData), signature: base64(sign('sha256', Buffer.concat([authData, hash(client)]), privateKey)), userHandle: handle } };
        }
    };
}

export async function authFixture(t) {
    const db = new PGlite();
    await db.exec('create role anon; create role authenticated; create role service_role;');
    const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
    await db.exec(schema);
    await db.exec(schema);
    const { rows: [project] } = await db.query("insert into projects(name,is_default) values('Test workspace',true) returning id");
    await db.query('insert into project_states(project_id) values($1)', [project.id]);
    const mailbox = { messages: [], fail: false };
    const backend = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            const table = url.pathname.split('/').at(-1);
            let body = '';
            for await (const chunk of req) body += chunk;
            const input = body ? JSON.parse(body) : null;
            const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data, (_, value) => typeof value === 'bigint' ? String(value) : value)); };
            if (url.pathname === '/test-inbox' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
                return res.end('LOCAL TEST MAILBOX - NOT REAL EMAIL\nRefresh after requesting a verification code.\n\n' + mailbox.messages.slice().reverse().map(message => `To: ${message.to.join(', ')}\n${message.text_body}`).join('\n\n----------------\n\n'));
            }
            if (url.pathname === '/v3/email/send' && req.method === 'POST') {
                if (mailbox.fail) return send(200, { data: { succeeded: 0, failed: 1, failures: ['Test rejection'] } });
                mailbox.messages.push(input);
                return send(200, { data: { succeeded: 1, failed: 0 } });
            }
            if (url.pathname.includes('/rpc/')) {
                const signatures = {
                    auth_complete: ['p_context', 'p_credential', 'p_new_token_hash', 'p_csrf_token'],
                    auth_issue_grant: ['p_email', 'p_nickname', 'p_project_id', 'p_role', 'p_purpose', 'p_token_hash', 'p_verified_by'],
                    auth_remove_passkey: ['p_session_hash', 'p_credential_id'],
                    auth_request_email: ['p_id', 'p_email', 'p_nickname', 'p_session_hash', 'p_code_hash'],
                    auth_verify_email: ['p_id', 'p_session_hash', 'p_code_hash', 'p_grant_hash'],
                    auth_change_role: ['p_session_hash', 'p_role']
                };
                const names = signatures[table];
                if (!names) return send(404, {});
                const values = names.map(name => typeof input[name] === 'object' && input[name] !== null ? JSON.stringify(input[name]) : input[name]);
                const { rows } = await db.query(`select ${identifier(table)}(${names.map((_, index) => '$' + (index + 1)).join(',')}) as result`, values);
                return send(200, rows[0].result);
            }
            if (!['app_users', 'memberships', 'projects', 'project_states', 'auth_sessions', 'auth_challenges', 'auth_passkeys', 'auth_grants', 'auth_audit', 'auth_email_codes'].includes(table)) return send(404, {});
            const values = [];
            const parameter = value => { values.push(value); return '$' + values.length; };
            const filters = [];
            for (const [key, value] of url.searchParams) {
                if (['select', 'order', 'limit', 'on_conflict'].includes(key)) continue;
                const separator = value.indexOf('.');
                const operator = { eq: '=', gt: '>', lt: '<' }[value.slice(0, separator)];
                if (!operator) throw new Error('Unsupported test filter');
                filters.push(`${identifier(key)}${operator}${parameter(value.slice(separator + 1))}`);
            }
            const where = filters.length ? ' where ' + filters.join(' and ') : '';
            const columns = url.searchParams.get('select');
            const selection = !columns || columns === '*' ? '*' : columns.split(',').map(identifier).join(',');
            let sql;
            if (req.method === 'GET') {
                sql = `select ${selection} from ${identifier(table)}${where}`;
                if (url.searchParams.has('order')) sql += ' order by ' + url.searchParams.get('order').split(',').map(part => { const [column, direction] = part.split('.'); return identifier(column) + (direction === 'desc' ? ' desc' : ' asc'); }).join(',');
                if (url.searchParams.has('limit')) sql += ' limit ' + parameter(Number(url.searchParams.get('limit')));
            } else if (req.method === 'DELETE') sql = `delete from ${identifier(table)}${where} returning ${selection}`;
            else if (req.method === 'POST') {
                const entries = Object.entries(input);
                sql = `insert into ${identifier(table)}(${entries.map(([key]) => identifier(key)).join(',')}) values(${entries.map(([, value]) => parameter(value && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value)).join(',')})`;
                if (req.headers.prefer?.includes('resolution=ignore-duplicates')) sql += ' on conflict do nothing';
                sql += ` returning ${selection}`;
            } else if (req.method === 'PATCH') sql = `update ${identifier(table)} set ${Object.entries(input).map(([key, value]) => identifier(key) + '=' + parameter(typeof value === 'object' ? JSON.stringify(value) : value)).join(',')}${where} returning ${selection}`;
            else return send(405, {});
            const { rows } = await db.query(sql, values);
            if (req.headers.accept?.includes('vnd.pgrst.object+json')) {
                if (rows.length !== 1) return send(406, { code: 'PGRST116', details: `The result contains ${rows.length} rows`, message: 'Single row required' });
                return send(200, rows[0]);
            }
            send(200, rows);
        } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: error.code, message: error.message }));
        }
    });
    const backendPort = await listen(backend);
    const temporary = createServer();
    const port = await listen(temporary);
    await new Promise(resolve => temporary.close(resolve));
    const origin = `http://localhost:${port}`;
    const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), DEMO_MODE: 'false', SUPABASE_URL: `http://127.0.0.1:${backendPort}`, SUPABASE_SERVICE_ROLE_KEY: 'test-only', AUTH_ORIGIN: origin, WEBAUTHN_RP_ID: 'localhost' };
    env.AUTH_TEST_MAIL_URL = `http://127.0.0.1:${backendPort}/v3/email/send`;
    env.EMAIL_CODE_SECRET = randomBytes(32).toString('hex');
    let child;
    async function stop() { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } }
    async function start() {
        child = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('API startup timeout')), 10000);
            child.stdout.on('data', data => { if (data.toString().includes('API ready')) { clearTimeout(timer); resolve(); } });
            child.once('exit', () => { clearTimeout(timer); reject(new Error('API startup failed')); });
        });
    }
    t.after(async () => { await stop(); await new Promise(resolve => backend.close(resolve)); await db.close(); });
    await start();
    const issue = async (email = 'person@abist.co.jp', purpose = 'enroll', role = 'designer') => {
        const token = randomBytes(32).toString('base64url');
        const { rows: [row] } = await db.query('select auth_issue_grant($1,$2,$3,$4,$5,$6,$7) as id', [email, 'Test User', project.id, role, purpose, digest(token), 'Operator: in-person verification']);
        return { token, userId: row.id };
    };
    function client() {
        let cookie = '', csrfToken = '';
        return {
            get cookie() { return cookie; },
            async request(path, { body, method = body === undefined ? 'GET' : 'POST', headers = {}, csrf = true, requestOrigin = origin } = {}) {
                const response = await fetch(origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(csrf && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
                for (const value of response.headers.getSetCookie()) cookie = value.split(';')[0];
                const data = await response.json();
                if (data.csrfToken) csrfToken = data.csrfToken;
                return { status: response.status, data, headers: response.headers };
            }
        };
    }
    return { db, env, origin, mailbox, inbox: `http://127.0.0.1:${backendPort}/test-inbox`, projectId: project.id, issue, client, restart: async () => { await stop(); await start(); } };
}

export async function enroll(client, key, origin, token) {
    await client.request('/auth/session');
    const options = await client.request('/auth/register/options', { body: { token, name: token ? 'Main key' : 'Backup key' } });
    if (options.status !== 200) return options;
    return client.request('/auth/register/verify', { body: { id: options.data.id, response: key.register(options.data.options, origin) } });
}

export async function login(client, key, origin, override) {
    await client.request('/auth/session');
    const options = await client.request('/auth/login/options', { body: {} });
    return client.request('/auth/login/verify', { body: { id: options.data.id, response: key.login(options.data.options, origin, override) } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { values } = parseArgs({ options: { email: { type: 'string', default: 'local-demo@abist.co.jp' } } });
    const email = companyEmail.parse(values.email);
    const cleanups = [];
    const fixture = await authFixture({ after: callback => cleanups.push(callback) });
    console.log('LOCAL PASSKEY PREVIEW: ephemeral PostgreSQL; no production database or paid service.');
    console.log(`Open self-registration: ${fixture.origin}/`);
    console.log(`Suggested test email: ${email}. New accounts default to designer; no real email is sent.`);
    console.log(`LOCAL TEST MAILBOX: ${fixture.inbox}`);
    console.log('Use Touch ID, Windows Hello, or a phone passkey. All preview data is lost when stopped.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { for (const cleanup of cleanups) await cleanup(); process.exit(0); });
}