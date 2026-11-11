import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { apply, validateRoute } from '../shared/domain.js';

const fixtureSql = await readFile(new URL('../supabase/seed-cad-demo.sql', import.meta.url), 'utf8');
async function database(t) {
    const db = new PGlite(); t.after(() => db.close());
    await db.exec('create role anon; create role authenticated; create role service_role;');
    await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
    return db;
}
async function load(db) {
    try { await db.exec(fixtureSql); } catch (error) { await db.exec('rollback;'); throw error; }
}

test('CAD fixture matches UI/domain contracts, preserves existing records and is idempotent', async t => {
    const db = await database(t);
    const { rows: [project] } = await db.query("insert into projects(name,is_default) values('Existing workspace',true) returning id");
    const existing = { raw: [{ id: 'existing-raw', text: 'Keep me' }], cards: [{ id: 'existing-card', title: 'Keep me' }], cores: [], events: [{ id: 'existing-event', action: 'Keep me', time: new Date().toISOString() }], customField: 'preserved' };
    await db.query('insert into project_states(project_id,revision,payload) values($1,7,$2)', [project.id, JSON.stringify(existing)]);
    await load(db);
    const { rows: [record] } = await db.query('select revision,payload from project_states where project_id=$1', [project.id]);
    const state = record.payload;
    assert.equal(Number(record.revision), 8);
    assert.equal(state.cards.length, 13); assert.equal(state.raw.length, 13); assert.equal(state.cores.length, 4);
    assert.equal(state.customField, 'preserved');
    assert.deepEqual(state.cards.find(card => card.id === 'existing-card'), existing.cards[0]);
    assert.deepEqual(state.raw.find(raw => raw.id === 'existing-raw'), existing.raw[0]);
    assert.deepEqual(state.events.find(event => event.id === 'existing-event'), existing.events[0]);
    const { rows: members } = await db.query('select user_id as id,display_name as name,role from memberships where project_id=$1', [project.id]);
    assert.equal(members.length, 4);
    const { rows: accounts } = await db.query('select email,password_hash from app_users');
    assert.ok(accounts.every(user => user.email.endsWith('@demo.invalid') && user.password_hash === null));
    for (const table of ['auth_passkeys', 'auth_sessions', 'auth_grants']) assert.equal((await db.query(`select * from ${table}`)).rows.length, 0);
    const counts = {};
    for (const card of state.cards.filter(card => card.demoDataset)) {
        counts[card.status] = (counts[card.status] || 0) + 1;
        assert.match(card.title, /検証用/); assert.equal(card.simulation, true);
        assert.ok(members.some(member => member.id === card.owner));
        const raw = state.raw.find(raw => raw.id === card.rawId);
        assert.ok(raw); assert.equal(raw.revision, card.rawRevision);
        assert.match(raw.text, /架空・検証専用/); assert.deepEqual(raw.files, []);
        assert.ok(Array.isArray(card.versions)); assert.ok(Array.isArray(card.votes));
        for (const field of ['conditions', 'action', 'rationale', 'limits', 'evidence']) assert.ok(card[field]?.length > 5, `${card.id}: ${field}`);
        if (card.route.length) validateRoute(card.route, members);
    }
    assert.deepEqual(counts, { review: 3, draft: 4, rejected: 1, returned: 1, core: 3 });
    const revised = state.cards.find(card => card.id === 'KC-CAD-DEMO-010');
    const historical = state.cores.find(core => core.cardId === revised.id);
    assert.equal(revised.version, 2); assert.equal(revised.status, 'draft');
    assert.equal(historical.snapshot.version, 1); assert.equal(historical.snapshot.rawRevision, 1);
    assert.equal(historical.snapshot.status, 'core');
    assert.equal(state.raw.find(raw => raw.id === revised.rawId).versions[0].revision, 1);
    for (const core of state.cores) {
        assert.equal(new Set(core.approvers).size, 2);
        assert.ok(core.approvers.some(id => members.find(member => member.id === id)?.role === 'senior'));
        assert.equal(core.approvedVersion, core.snapshot.version);
        assert.deepEqual(core.approvers, core.snapshot.votes);
    }
    for (let index = 1; index < state.events.length; index++) assert.ok(Date.parse(state.events[index - 1].time) >= Date.parse(state.events[index].time));
    await load(db);
    assert.deepEqual((await db.query('select revision,payload from project_states where project_id=$1', [project.id])).rows[0], record);

    const pending = state.cards.find(card => card.id === 'KC-CAD-DEMO-005');
    const senior = members.find(member => member.role === 'senior');
    apply(state, senior, members, 'decide', { id: pending.id, version: 1, decision: 'approve', importance: pending.importance, priority: pending.priority, category: pending.category });
    assert.equal(pending.status, 'core'); assert.equal(state.cores.length, 5);
    const returned = state.cards.find(card => card.status === 'returned');
    apply(state, members.find(member => member.id === returned.owner), members, 'revise', { id: returned.id, version: 1, text: '【検証用】メーカー確認資料を追記。' });
    assert.equal(returned.version, 2); assert.equal(returned.status, 'draft');
    const unresolved = state.cards.find(card => card.id === 'KC-CAD-DEMO-011');
    assert.throws(() => apply(state, members.find(member => member.id === unresolved.owner), members, 'submit', { id: unresolved.id, version: 1, problem: unresolved.problem, route: pending.route }), /未確認/);
    await db.query('update project_states set payload=$1 where project_id=$2', [JSON.stringify(state), project.id]);
    await load(db);
    assert.deepEqual((await db.query('select payload from project_states where project_id=$1', [project.id])).rows[0].payload, state);
});

test('CAD fixture refuses a missing default project and rolls back ID conflicts without partial inserts', async t => {
    const db = await database(t);
    await assert.rejects(load(db), /default workspace/);
    assert.equal((await db.query('select * from app_users')).rows.length, 0);
    const { rows: [project] } = await db.query("insert into projects(name,is_default) values('Existing workspace',true) returning id");
    const payload = { raw: [], cards: [{ id: 'KC-CAD-DEMO-005', title: 'Real existing record' }], cores: [], events: [] };
    await db.query('insert into project_states(project_id,revision,payload) values($1,9,$2)', [project.id, JSON.stringify(payload)]);
    await assert.rejects(load(db), /Card ID conflict/);
    const { rows: [record] } = await db.query('select revision,payload from project_states where project_id=$1', [project.id]);
    assert.equal(Number(record.revision), 9); assert.deepEqual(record.payload, payload);
    assert.equal((await db.query('select * from app_users')).rows.length, 0);
    assert.equal((await db.query('select * from memberships')).rows.length, 0);
});

test('CAD fixture initializes only missing state and never overwrites an existing identity', async t => {
    const db = await database(t);
    const { rows: [project] } = await db.query("insert into projects(name,is_default) values('Existing workspace',true) returning id");
    const actorId = 'cad00000-0000-4000-8000-000000000001';
    await db.query('insert into app_users(id,nickname,email,password_hash) values($1,$2,$3,$4)', [actorId, 'Existing person', 'existing@abist.co.jp', 'existing-hash']);
    await assert.rejects(load(db), /identity conflicts/);
    assert.equal((await db.query('select * from project_states')).rows.length, 0);
    assert.equal((await db.query('select nickname from app_users where id=$1', [actorId])).rows[0].nickname, 'Existing person');
    await db.query('delete from app_users where id=$1', [actorId]);
    await load(db);
    const { rows } = await db.query('select revision,payload from project_states where project_id=$1', [project.id]);
    assert.equal(Number(rows[0].revision), 1); assert.equal(rows[0].payload.cards.length, 12);
});