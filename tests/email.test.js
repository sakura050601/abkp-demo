import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailer, emailCodeHash } from '../server/email.js';

test('email configuration fails closed and never enables a test mailbox on a public origin', () => {
    assert.equal(createMailer('https://example.com', {}).ready, false);
    assert.throws(() => createMailer('https://example.com', { NODE_ENV: 'production', AUTH_TEST_MAIL_URL: 'http://localhost:1234' }));
    assert.throws(() => createMailer('http://localhost:1234', { NODE_ENV: 'test', AUTH_TEST_MAIL_URL: 'https://other.example.com' }));
    assert.notEqual(emailCodeHash('request', '12345678', 'secret'), emailCodeHash('other', '12345678', 'secret'));
});

test('public deployment needs a verified sender, API key and a sufficiently long code secret', () => {
    const config = { MAIL_FROM: 'verified-sender@example.com', SMTP2GO_API_KEY: 'test-key', EMAIL_CODE_SECRET: 's'.repeat(32) };
    assert.equal(createMailer('https://demo.onrender.com', config).ready, true);
    for (const name of Object.keys(config)) assert.equal(createMailer('https://demo.onrender.com', { ...config, [name]: '' }).ready, false, name);
    assert.equal(createMailer('https://demo.onrender.com', { ...config, EMAIL_CODE_SECRET: 'too-short' }).ready, false);
});

test('email API checks provider-level errors even when HTTP status is 200', async () => {
    const env = { MAIL_FROM: 'sender@example.com', SMTP2GO_API_KEY: 'test-key', EMAIL_CODE_SECRET: 's'.repeat(32) };
    let captured;
    const good = createMailer('https://example.com', env, async (url, options) => { captured = { url, options }; return { ok: true, json: async () => ({ data: { succeeded: 1, failed: 0 } }) }; });
    await good.sendCode('employee@abist.co.jp', '12345678');
    assert.equal(captured.url, 'https://api.smtp2go.com/v3/email/send');
    assert.deepEqual(JSON.parse(captured.options.body).to, ['employee@abist.co.jp']);
    for (const data of [{ error: 'Quota' }, { succeeded: 0, failed: 1 }, { succeeded: 1, failed: 0, failures: ['rejected'] }]) {
        const bad = createMailer('https://example.com', env, async () => ({ ok: true, json: async () => ({ data }) }));
        await assert.rejects(bad.sendCode('employee@abist.co.jp', '12345678'));
    }
});