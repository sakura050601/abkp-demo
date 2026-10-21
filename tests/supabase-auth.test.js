import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

const projectId = randomUUID();
const tables = {
    app_users: [],
    projects: [{ id: projectId, name: 'Test workspace', is_default: true }],
    memberships: [],
    project_states: [{ project_id: projectId, revision: 0, payload: { raw: [], cards: [], cores: [], events: [] } }]
};

const fakeSupabase = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const table = url.pathname.split('/').at(-1);
    if (!tables[table]) return respond(res, 404, { message: 'table not found' });
    const select = url.searchParams.get('select');
    if (req.method === 'GET') {
        let rows = tables[table].filter(row => [...url.searchParams].every(([key, value]) => {
            if (key === 'select' || key === 'order' || key === 'limit') return true;
            const separator = value.indexOf('.');
            const operator = value.slice(0, separator);
            const expected = value.slice(separator + 1);
            return operator !== 'eq' || String(row[key]) === expected;
        }));
        const limit = Number(url.searchParams.get('limit'));
        if (limit) rows = rows.slice(0, limit);
        return respond(res, 200, project(rows, select), req.headers.accept?.includes('vnd.pgrst.object+json'));
    }
    if (req.method === 'POST') {
        const body = await readBody(req);
        const rows = Array.isArray(body) ? body : [body];
        if (table === 'app_users' && rows.some(input => tables.app_users.some(user => user.email === input.email))) {
            return respond(res, 409, { code: '23505', message: 'duplicate email' });
        }
        const saved = rows.map(input => {
            const existing = table === 'memberships' && tables.memberships.find(row => row.project_id === input.project_id && row.user_id === input.user_id);
            if (existing) return Object.assign(existing, input);
            const row = { ...input, ...(input.id ? {} : { id: randomUUID() }) };
            tables[table].push(row);
            return row;
        });
        if (req.headers.prefer?.includes('return=representation')) return respond(res, 201, project(saved, select), req.headers.accept?.includes('vnd.pgrst.object+json'));
        return respond(res, 201, null);
    }
    return respond(res, 405, { message: 'unsupported method' });
});

function project(rows, select) {
    if (!select || select === '*') return rows;
    const columns = select.split(',');
    return rows.map(row => Object.fromEntries(columns.map(column => [column, row[column]])));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let text = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { text += chunk; });
        req.on('end', () => { try { resolve(text ? JSON.parse(text) : null); } catch (error) { reject(error); } });
        req.on('error', reject);
    });
}

function respond(res, status, data, single = false) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    if (data === null) return res.end();
    if (single && Array.isArray(data)) return res.end(JSON.stringify(data[0] ?? {}));
    res.end(JSON.stringify(data));
}

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('Supabase mode registers, authenticates, loads state, and logs out app users', async t => {
    const supabasePort = await listen(fakeSupabase);
    const apiPort = await new Promise(resolve => {
        const temporary = createServer();
        temporary.listen(0, '127.0.0.1', () => {
            const port = temporary.address().port;
            temporary.close(() => resolve(port));
        });
    });
    const child = spawn(process.execPath, ['server/index.js'], {
        env: { ...process.env, PORT: String(apiPort), DEMO_MODE: 'false', SUPABASE_URL: `http://127.0.0.1:${supabasePort}`, SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(async () => {
        if (child.exitCode === null) {
            child.kill();
            await once(child, 'exit');
        }
        await new Promise(resolve => fakeSupabase.close(resolve));
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server timeout')), 10000);
        child.stdout.on('data', data => {
            if (data.toString().includes('API ready')) { clearTimeout(timer); resolve(); }
        });
        child.once('exit', () => reject(new Error('server startup failed')));
    });

    const request = async (path, { token, body, method = body ? 'POST' : 'GET' } = {}) => {
        const response = await fetch(`http://127.0.0.1:${apiPort}/api${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        return { status: response.status, data: await response.json() };
    };

    assert.deepEqual(await request('/config'), { status: 200, data: { demo: false, authMode: 'app-users' } });
    const registration = await request('/register', { body: { nickname: 'Test User', email: 'TEST@example.test', password: 'secure-test-pass' } });
    assert.equal(registration.status, 201);
    assert.ok(registration.data.token);
    assert.match(tables.app_users[0].id, /^[0-9a-f-]{36}$/i);
    assert.match(tables.app_users[0].password_hash, /^scrypt\$/);
    assert.notEqual(tables.app_users[0].password_hash, 'secure-test-pass');
    assert.equal(tables.memberships[0].role, 'designer');

    const state = await request('/state', { token: registration.data.token });
    assert.equal(state.status, 200);
    assert.equal(state.data.user.name, 'Test User');
    assert.equal(state.data.mode, 'supabase');

    assert.equal((await request('/login', { body: { email: 'test@example.test', password: 'wrong-password' } })).status, 401);
    const login = await request('/login', { body: { email: 'test@example.test', password: 'secure-test-pass' } });
    assert.equal(login.status, 200);
    assert.ok(login.data.token);
    assert.equal((await request('/register', { body: { nickname: 'Duplicate', email: 'test@example.test', password: 'secure-test-pass' } })).status, 409);
    assert.equal((await request('/logout', { token: login.data.token, body: {} })).status, 200);
    assert.equal((await request('/state', { token: login.data.token })).status, 401);
});