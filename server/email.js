import { createHmac } from 'node:crypto';
import { z } from 'zod';

export const emailCodeHash = (id, code, secret) => createHmac('sha256', secret).update(`${id}:${code}`).digest('hex');

export function createMailer(origin, env = process.env, send = fetch) {
    let endpoint = 'https://api.smtp2go.com/v3/email/send';
    if (env.AUTH_TEST_MAIL_URL) {
        const target = new URL(env.AUTH_TEST_MAIL_URL);
        if (env.NODE_ENV !== 'test' || !['localhost', '127.0.0.1'].includes(new URL(origin).hostname) || target.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(target.hostname)) throw new Error('Test mailbox is restricted to loopback test environments');
        endpoint = target.href;
    }
    const sender = env.MAIL_FROM || (env.AUTH_TEST_MAIL_URL ? 'local-demo@example.test' : '');
    const key = env.SMTP2GO_API_KEY || (env.AUTH_TEST_MAIL_URL ? 'local-test-only' : '');
    const secret = env.EMAIL_CODE_SECRET || '';
    const ready = z.email().safeParse(sender).success && !!key && secret.length >= 32;
    return {
        ready,
        hash: (id, code) => emailCodeHash(id, code, secret),
        async sendCode(email, code) {
            if (!ready) throw new Error('Email verification is not configured');
            const response = await send(endpoint, {
                method: 'POST', signal: AbortSignal.timeout(10000),
                headers: { 'Content-Type': 'application/json', 'X-Smtp2go-Api-Key': key },
                body: JSON.stringify({ sender, to: [email], subject: '設計ナレッジ メールアドレス確認', text_body: `確認コード: ${code}\n\n有効期限は10分です。登録を開始したブラウザーに入力してください。\nこのコードを他人に共有しないでください。心当たりがない場合は破棄してください。`, fastaccept: false })
            });
            const payload = await response.json();
            if (!response.ok || payload.data?.succeeded !== 1 || payload.data?.failed || payload.data?.failures?.length || payload.data?.error) throw new Error('Email provider did not accept the verification email');
        }
    };
}