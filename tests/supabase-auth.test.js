import test from 'node:test';
import assert from 'node:assert/strict';
import { authFixture, authenticator, enroll, login } from './auth-support.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('operator CLI initializes safely, verifies identity and issues single-use enrollment/recovery grants', async t => {
    const fixture = await authFixture(t);
    const command = args => promisify(execFile)(process.execPath, ['server/auth-admin.js', ...args], { env: fixture.env });
    await fixture.db.query('delete from project_states');
    await fixture.db.query('delete from projects');
    await command(['--init']);
    await command(['--init']);
    assert.equal((await fixture.db.query('select * from projects')).rows.length, 1);
    assert.equal((await fixture.db.query('select * from project_states')).rows.length, 1);
    await assert.rejects(command(['--email', 'operator@abist.co.jp', '--nickname', 'Operator']));
    for (const email of ['operator@example.test', 'operator@absit.co.jp', 'operator@sub.abist.co.jp', 'operator@abist.co.jp.evil.example']) {
        for (const recover of [false, true]) await assert.rejects(command(['--email', email, '--nickname', 'Operator', '--verified-by', 'Admin: verified in person', ...(recover ? ['--recover'] : [])]), /Only @abist\.co\.jp/);
    }
    assert.equal((await fixture.db.query('select * from app_users')).rows.length, 0);
    const args = ['--email', '  Operator@ABIST.CO.JP  ', '--nickname', 'Operator', '--verified-by', 'Admin: verified in person'];
    const { stdout } = await command(args);
    assert.match(stdout, /Recipient: operator@abist\.co\.jp/);
    assert.match(stdout, /No email has been sent automatically/);
    const token = new URL(stdout.trim().split('\n').at(-1)).hash.slice('#enroll='.length);
    const client = fixture.client();
    assert.equal((await enroll(client, authenticator(), fixture.origin, token)).status, 200);
    const state = await client.request('/state');
    assert.equal(state.data.user.role, 'viewer');
    assert.equal((await client.request('/commands', { body: { command: 'create', revision: 0, payload: { text: 'Example', consent: true } } })).status, 403);
    await assert.rejects(command(args));
    await command([...args, '--recover']);
    assert.equal((await client.request('/state')).status, 401);
    const { rows: [privileges] } = await fixture.db.query("select has_table_privilege('anon','auth_passkeys','SELECT') as can_read, has_function_privilege('authenticated','auth_complete(jsonb,jsonb,text,text)','EXECUTE') as can_finish");
    assert.equal(privileges.can_read, false);
    assert.equal(privileges.can_finish, false);
});

test('production: invitation-only enrollment, cookie rotation, CSRF, persistence and project permissions', async t => {
    const fixture = await authFixture(t);
    const client = fixture.client(), key = authenticator();
    assert.equal((await client.request('/state')).status, 401);
    const anonymous = await client.request('/auth/session');
    assert.match(anonymous.headers.get('set-cookie'), /HttpOnly/);
    assert.match(anonymous.headers.get('set-cookie'), /SameSite=Lax/);
    const oldCookie = client.cookie;
    assert.equal((await client.request('/register', { body: {} })).status, 410);
    assert.equal((await client.request('/login', { body: {} })).status, 410);
    assert.equal((await client.request('/auth/register/options', { body: {} })).status, 401);
    assert.equal((await client.request('/auth/register/options', { body: { token: 'a'.repeat(43) } })).status, 400);
    const invitation = await fixture.issue();
    assert.equal((await enroll(client, key, fixture.origin, invitation.token)).status, 200);
    assert.notEqual(client.cookie, oldCookie);
    assert.equal((await client.request('/state', { headers: { Cookie: oldCookie } })).status, 401);
    const state = await client.request('/state');
    assert.equal(state.data.user.id, invitation.userId);
    assert.equal(state.data.user.role, 'designer');
    assert.equal((await client.request('/auth/passkeys/remove', { body: { id: key.id }, csrf: false })).status, 403);
    assert.equal((await client.request('/auth/passkeys/remove', { body: { id: key.id }, requestOrigin: 'https://evil.example' })).status, 403);
    assert.equal((await client.request('/auth/passkeys/remove', { body: { id: key.id }, requestOrigin: null })).status, 403);
    assert.equal((await client.request('/auth/passkeys/remove', { body: { id: key.id } })).status, 409);
    assert.equal((await client.request('/auth/register/options', { body: { token: invitation.token } })).status, 400);
    assert.equal((await client.request('/commands', { body: { command: 'create', revision: 0, payload: { text: 'Example', consent: true } } })).status, 200);
    await fixture.restart();
    assert.equal((await client.request('/state')).status, 200);
    await fixture.db.query('delete from memberships where user_id=$1', [invitation.userId]);
    assert.equal((await client.request('/state')).status, 403);
    assert.equal((await client.request('/auth/logout', { body: {} })).status, 200);
    assert.equal((await client.request('/state')).status, 401);
    const { rows } = await fixture.db.query('select password_hash from app_users where id=$1', [invitation.userId]);
    assert.equal(rows[0].password_hash, null);
});

test('company registration rejects database bypasses and legacy invitations and rechecks email at completion', async t => {
    const fixture = await authFixture(t);
    for (const email of ['outside@example.test', 'outside@absit.co.jp', 'outside@sub.abist.co.jp', 'outside@abist.co.jp.evil.example', 'outside@abist.co.jp@evil.example', null]) {
        for (const purpose of ['enroll', 'recover']) await assert.rejects(fixture.issue(email, purpose), /Only @abist\.co\.jp/);
    }
    assert.equal((await fixture.db.query('select * from app_users')).rows.length, 0);
    assert.equal((await fixture.db.query('select * from auth_grants')).rows.length, 0);

    const legacy = await fixture.issue('legacy@abist.co.jp');
    await fixture.db.query('update app_users set email=$1 where id=$2', ['legacy@example.test', legacy.userId]);
    const legacyClient = fixture.client();
    assert.equal((await enroll(legacyClient, authenticator(), fixture.origin, legacy.token)).status, 403);
    assert.equal((await fixture.db.query('select * from auth_passkeys where user_id=$1', [legacy.userId])).rows.length, 0);

    const invitation = await fixture.issue('  Employee.Name@ABIST.CO.JP  ');
    const client = fixture.client(), key = authenticator();
    await client.request('/auth/session');
    const options = await client.request('/auth/register/options', { body: { token: invitation.token, email: 'attacker@example.test' } });
    assert.equal(options.status, 200);
    assert.equal(options.data.options.user.name, 'employee.name@abist.co.jp');
    await fixture.db.query('update app_users set email=$1 where id=$2', ['changed@example.test', invitation.userId]);
    assert.equal((await client.request('/auth/register/verify', { body: { id: options.data.id, response: key.register(options.data.options, fixture.origin) } })).status, 409);
    assert.equal((await fixture.db.query('select * from auth_passkeys where user_id=$1', [invitation.userId])).rows.length, 0);
    assert.equal((await fixture.db.query('select * from auth_grants where user_id=$1', [invitation.userId])).rows.length, 1);
    assert.equal((await client.request('/state')).status, 401);
    await fixture.db.query('update app_users set email=$1 where id=$2', ['employee.name@abist.co.jp', invitation.userId]);
    assert.equal((await enroll(client, key, fixture.origin, invitation.token)).status, 200);
    const { rows: [user] } = await fixture.db.query('select email from app_users where id=$1', [invitation.userId]);
    assert.equal(user.email, 'employee.name@abist.co.jp');
    await client.request('/auth/logout', { body: {} });
    assert.equal((await login(client, key, fixture.origin)).status, 200);
});

test('grants expire, concurrent enrollment is single-use, and failed enrollment rolls back atomically', async t => {
    const fixture = await authFixture(t);
    const first = fixture.client(), second = fixture.client();
    const invitation = await fixture.issue();
    await fixture.db.query("update auth_grants set expires_at=now()-interval '1 second'");
    assert.equal((await enroll(first, authenticator(), fixture.origin, invitation.token)).status, 400);
    const fresh = await fixture.issue();
    await second.request('/auth/session');
    const firstOptions = await first.request('/auth/register/options', { body: { token: fresh.token } });
    const secondOptions = await second.request('/auth/register/options', { body: { token: fresh.token } });
    const responses = await Promise.all([
        first.request('/auth/register/verify', { body: { id: firstOptions.data.id, response: authenticator().register(firstOptions.data.options, fixture.origin) } }),
        second.request('/auth/register/verify', { body: { id: secondOptions.data.id, response: authenticator().register(secondOptions.data.options, fixture.origin) } })
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal((await fixture.db.query('select * from auth_passkeys where user_id=$1', [fresh.userId])).rows.length, 1);
    const removed = await fixture.issue('removed@abist.co.jp');
    await fixture.db.query('delete from memberships where user_id=$1', [removed.userId]);
    const client = fixture.client(), key = authenticator();
    assert.equal((await enroll(client, key, fixture.origin, removed.token)).status, 409);
    assert.equal((await fixture.db.query('select * from auth_passkeys where user_id=$1', [removed.userId])).rows.length, 0);
    assert.equal((await fixture.db.query('select * from auth_grants where user_id=$1', [removed.userId])).rows.length, 1);
    await fixture.db.query("insert into memberships(project_id,user_id,display_name,role) values($1,$2,'Restored','viewer')", [fixture.projectId, removed.userId]);
    assert.equal((await enroll(client, key, fixture.origin, removed.token)).status, 200);
});

test('WebAuthn: real signatures reject wrong UV, origin, rpID, challenge, user handle and replay', async t => {
    const fixture = await authFixture(t);
    const client = fixture.client(), key = authenticator();
    const invitation = await fixture.issue();
    await client.request('/auth/session');
    for (const override of [{ uv: false }, { rpID: 'evil.example' }]) {
        const options = await client.request('/auth/register/options', { body: { token: invitation.token } });
        const response = key.register(options.data.options, fixture.origin, override);
        assert.equal((await client.request('/auth/register/verify', { body: { id: options.data.id, response } })).status, 400);
    }
    assert.equal((await enroll(client, key, fixture.origin, invitation.token)).status, 200);
    assert.equal((await client.request('/auth/logout', { body: {} })).status, 200);
    await client.request('/auth/session');
    for (const variant of ['uv', 'origin', 'rpID', 'challenge', 'signature', 'handle']) {
        const options = await client.request('/auth/login/options', { body: {} });
        const response = key.login(variant === 'challenge' ? { ...options.data.options, challenge: 'wrong-challenge' } : options.data.options, variant === 'origin' ? 'https://evil.example' : fixture.origin, variant === 'uv' ? { uv: false } : variant === 'rpID' ? { rpID: 'evil.example' } : variant === 'handle' ? { handle: 'wrong-user' } : {});
        if (variant === 'signature') response.response.signature = 'a'.repeat(86);
        assert.equal((await client.request('/auth/login/verify', { body: { id: options.data.id, response } })).status, 400, variant);
    }
    const options = await client.request('/auth/login/options', { body: {} });
    const response = key.login(options.data.options, fixture.origin);
    const other = fixture.client(); await other.request('/auth/session');
    assert.equal((await other.request('/auth/login/verify', { body: { id: options.data.id, response } })).status, 400);
    assert.equal((await client.request('/auth/login/verify', { body: { id: options.data.id, response } })).status, 200);
    assert.equal((await client.request('/auth/login/verify', { body: { id: options.data.id, response } })).status, 400);
});

test('backup, expiry, recovery and migration preserve identity while revoking old credentials and sessions', async t => {
    const fixture = await authFixture(t);
    const client = fixture.client(), secondClient = fixture.client();
    const main = authenticator(), backup = authenticator(), replacement = authenticator();
    const invitation = await fixture.issue('existing@abist.co.jp');
    await fixture.db.query('update app_users set password_hash=$1 where id=$2', ['legacy-password-hash', invitation.userId]);
    assert.equal((await enroll(client, main, fixture.origin, invitation.token)).status, 200);
    assert.equal((await enroll(client, backup, fixture.origin)).status, 200);
    assert.equal((await login(secondClient, backup, fixture.origin)).status, 200);
    assert.equal((await client.request('/auth/passkeys/remove', { body: { id: backup.id } })).status, 200);
    assert.equal((await secondClient.request('/state')).status, 401);
    const staleOptions = await client.request('/auth/login/options', { body: {} });
    const recovered = await fixture.issue('existing@abist.co.jp', 'recover');
    assert.equal(recovered.userId, invitation.userId);
    assert.equal((await client.request('/state')).status, 401);
    assert.equal((await login(secondClient, main, fixture.origin)).status, 400);
    assert.equal((await enroll(secondClient, replacement, fixture.origin, recovered.token)).status, 200);
    assert.equal((await secondClient.request('/auth/login/verify', { body: { id: staleOptions.data.id, response: main.login(staleOptions.data.options, fixture.origin) } })).status, 400);
    assert.equal((await secondClient.request('/state')).data.user.id, invitation.userId);
    const { rows } = await fixture.db.query('select action,verified_by from auth_audit where user_id=$1', [invitation.userId]);
    assert.ok(rows.some(row => row.action === 'recover_issued' && row.verified_by));
    await fixture.db.query("update auth_sessions set authenticated_at=now()-interval '6 minutes' where user_id=$1", [invitation.userId]);
    assert.equal((await secondClient.request('/auth/register/options', { body: {} })).status, 401);
    assert.equal((await login(secondClient, replacement, fixture.origin)).status, 200);
    const options = await secondClient.request('/auth/login/options', { body: {} });
    await fixture.db.query("update auth_challenges set expires_at=now()-interval '1 second'");
    assert.equal((await secondClient.request('/auth/login/verify', { body: { id: options.data.id, response: replacement.login(options.data.options, fixture.origin) } })).status, 400);
    await fixture.db.query("update auth_sessions set expires_at=now()-interval '1 second'");
    assert.equal((await secondClient.request('/state')).status, 401);
});