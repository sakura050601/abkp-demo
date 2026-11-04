import test from 'node:test';
import assert from 'node:assert/strict';
import { authFixture, authenticator, enroll, login } from './auth-support.js';

const latestCode = fixture => fixture.mailbox.messages.at(-1).text_body.match(/\d{8}/)[0];

test('session expiry and CSRF mismatch have explicit pre-operation recovery codes', async t => {
    const fixture = await authFixture(t), client = fixture.client();
    const expired = await client.request('/auth/login/options', { body: {} });
    assert.equal(expired.status, 401); assert.equal(expired.data.code, 'SESSION_EXPIRED');
    await client.request('/auth/session');
    const stale = await client.request('/auth/login/options', { body: {}, csrf: false });
    assert.equal(stale.status, 403); assert.equal(stale.data.code, 'CSRF_MISMATCH');
    assert.equal((await fixture.db.query('select * from auth_challenges')).rows.length, 0);
    const allowed = await client.request('/auth/login/options', { body: {} });
    assert.equal(allowed.status, 200);
});

test('employee self-registration proves company mailbox, defaults to designer and allows only designer/IT switching', async t => {
    const fixture = await authFixture(t);
    const client = fixture.client(), other = fixture.client(), key = authenticator();
    await client.request('/auth/session'); await other.request('/auth/session');
    assert.equal((await client.request('/auth/signup/request', { body: { email: 'outside@example.com', nickname: 'Employee' } })).status, 400);
    assert.equal(fixture.mailbox.messages.length, 0);
    const request = await client.request('/auth/signup/request', { body: { email: 'EMPLOYEE@ABIST.CO.JP', nickname: 'Employee', role: 'senior' } });
    assert.equal(request.status, 200);
    assert.equal(request.data.code, undefined);
    assert.equal(request.data.email, 'employee@abist.co.jp');
    assert.equal((await fixture.db.query('select * from app_users')).rows.length, 0);
    const code = latestCode(fixture);
    assert.equal((await other.request('/auth/signup/verify', { body: { id: request.data.id, code } })).status, 400);
    const verified = await client.request('/auth/signup/verify', { body: { id: request.data.id, code } });
    assert.equal(verified.status, 200);
    assert.equal((await other.request('/auth/register/options', { body: { token: verified.data.token } })).status, 400);
    assert.equal((await client.request('/auth/signup/verify', { body: { id: request.data.id, code } })).status, 400);
    assert.equal((await enroll(client, key, fixture.origin, verified.data.token)).status, 200);
    let state = await client.request('/state');
    assert.equal(state.data.user.role, 'designer');
    await fixture.db.query('update project_states set payload=$1 where project_id=$2', [JSON.stringify({ raw: [], cards: [{ id: 'PENDING', status: 'review', route: [{ assignees: [state.data.user.id] }], votes: [state.data.user.id] }], cores: [], events: [] }), fixture.projectId]);
    assert.equal((await fixture.db.query('select project_id from memberships')).rows[0].project_id, fixture.projectId);
    assert.equal((await client.request('/profile/role', { body: { role: 'senior' } })).status, 400);
    assert.equal((await client.request('/profile/role', { body: { role: 'it', userId: 'other' } })).status, 400);
    assert.equal((await client.request('/profile/role', { body: { role: 'it' } })).status, 200);
    state = await client.request('/state'); assert.equal(state.data.user.role, 'it');
    assert.equal(state.data.payload.cards[0].status, 'returned');
    assert.deepEqual(state.data.payload.cards[0].votes, []);
    assert.equal(state.data.payload.events[0].action, '役割変更による差戻し');
    const created = await client.request('/commands', { body: { command: 'create', revision: state.data.revision, payload: { text: 'Example material', consent: true } } });
    assert.equal(created.status, 200);
    state = await client.request('/state');
    for (const decision of ['approve', 'return', 'reject']) assert.equal((await client.request('/commands', { body: { command: 'decide', revision: state.data.revision, payload: { id: created.data.id, version: 1, decision, reason: 'Reason' } } })).status, 403);
    assert.equal((await client.request('/profile/role', { body: { role: 'designer' } })).status, 200);
    await client.request('/auth/logout', { body: {} });
    assert.equal((await login(client, key, fixture.origin)).status, 200);
});

test('email codes enforce resend cooldown, expiry, attempt limits and one-time use', async t => {
    const fixture = await authFixture(t), client = fixture.client();
    await client.request('/auth/session');
    const body = { email: 'employee@abist.co.jp', nickname: 'Employee' };
    const first = await client.request('/auth/signup/request', { body });
    assert.equal((await client.request('/auth/signup/request', { body })).status, 429);
    const actual = latestCode(fixture), wrong = actual === '00000000' ? '11111111' : '00000000';
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await client.request('/auth/signup/verify', { body: { id: first.data.id, code: wrong } })).status, 400);
    assert.equal((await client.request('/auth/signup/verify', { body: { id: first.data.id, code: actual } })).status, 400);
    const { rows: [record] } = await fixture.db.query('select * from auth_email_codes where id=$1', [first.data.id]);
    assert.equal(record.attempts, 5); assert.notEqual(record.code_hash, actual);
    await fixture.db.query("update auth_email_codes set created_at=now()-interval '2 minutes'");
    const second = await client.request('/auth/signup/request', { body });
    assert.equal(second.status, 200);
    await fixture.db.query("update auth_email_codes set expires_at=now()-interval '1 second' where id=$1", [second.data.id]);
    assert.equal((await client.request('/auth/signup/verify', { body: { id: second.data.id, code: latestCode(fixture) } })).status, 400);
    assert.equal((await fixture.db.query('select * from app_users')).rows.length, 0);
});

test('mail delivery failures do not permit registration; viewer and senior cannot self-escalate', async t => {
    const fixture = await authFixture(t), client = fixture.client();
    await client.request('/auth/session'); fixture.mailbox.fail = true;
    assert.equal((await client.request('/auth/signup/request', { body: { email: 'employee@abist.co.jp', nickname: 'Employee' } })).status, 503);
    assert.equal((await fixture.db.query('select consumed from auth_email_codes')).rows[0].consumed, true);
    assert.equal((await fixture.db.query('select * from app_users')).rows.length, 0);
    for (const role of ['viewer', 'senior']) {
        const account = await fixture.issue(`${role}@abist.co.jp`, 'enroll', role);
        const user = fixture.client(); await enroll(user, authenticator(), fixture.origin, account.token);
        assert.equal((await user.request('/profile/role', { body: { role: 'designer' } })).status, 403);
    }
});