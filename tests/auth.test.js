import test from 'node:test';
import assert from 'node:assert/strict';
import { authConfig, companyEmail, digest } from '../server/auth.js';

test('company invitations accept only the exact abist.co.jp domain and normalize email', () => {
    assert.equal(companyEmail.parse('1000001@abist.co.jp'), '1000001@abist.co.jp');
    assert.equal(companyEmail.parse('  Employee.Name@ABIST.CO.JP  '), 'employee.name@abist.co.jp');
    for (const email of ['employee@gmail.com', 'employee@absit.co.jp', 'employee@sub.abist.co.jp', 'employee@abist.co.jp.evil.example', 'employee@evilabist.co.jp', 'employee@abist.co.jp@evil.example', 'abist.co.jp', '@abist.co.jp', 'employee\n@abist.co.jp']) assert.equal(companyEmail.safeParse(email).success, false, email);
});

test('passkey configuration fails closed and fixes the relying party to one origin', () => {
    assert.throws(() => authConfig({}), /AUTH_ORIGIN/);
    for (const origin of ['http://example.com', 'https://example.com/', 'https://example.com/path', 'https://user:pass@example.com']) assert.throws(() => authConfig({ AUTH_ORIGIN: origin }));
    assert.throws(() => authConfig({ AUTH_ORIGIN: 'http://localhost:5173', NODE_ENV: 'production' }));
    assert.throws(() => authConfig({ AUTH_ORIGIN: 'https://example.com', WEBAUTHN_RP_ID: 'other.com' }));
    assert.deepEqual(authConfig({ AUTH_ORIGIN: 'https://example.com' }), { origin: 'https://example.com', rpID: 'example.com', secure: true, cookieName: '__Host-kp-session' });
    assert.equal(authConfig({ AUTH_ORIGIN: 'http://localhost:5173' }).secure, false);
});

test('database token hashes do not contain bearer secrets', () => {
    assert.equal(digest('test').length, 64);
    assert.equal(digest('test'), digest('test'));
    assert.notEqual(digest('test'), digest('other'));
});