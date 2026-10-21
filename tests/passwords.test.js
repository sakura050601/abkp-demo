import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../server/passwords.js';

test('password hashes are salted and verify without storing plaintext', async () => {
    const first = await hashPassword('test-password-123');
    const second = await hashPassword('test-password-123');

    assert.notEqual(first, second);
    assert.match(first, /^scrypt\$/);
    assert.equal(await verifyPassword('test-password-123', first), true);
    assert.equal(await verifyPassword('wrong-password', first), false);
    assert.equal(await verifyPassword('test-password-123', 'invalid'), false);
});