import { z } from 'zod';

export const MAX_LEDGER_BYTES = 1024 * 1024;
const required = max => z.string().max(max).refine(value => value.trim().length > 0);
const tags = z.array(required(160)).max(80);
const record = z.object({
    id: required(80).refine(value => /^[A-Za-z0-9._-]+$/.test(value)),
    kind: z.enum(['forbid', 'require', 'rule', 'exercise', 'fact', 'reference']),
    text: required(12000),
    scope: required(500),
    source: required(6000),
    topics: tags,
    match: tags.optional(),
    reconfirmed: z.string().max(6000).optional(),
    violated_by: z.string().max(6000).nullable().optional(),
    note: z.string().max(6000).optional()
}).strict();
const descriptions = z.record(z.string().max(100), z.string().max(6000));
const ledger = z.object({
    directives: z.array(record).min(1).max(500),
    note: z.string().max(12000).optional(),
    incomplete: z.boolean().optional(),
    incomplete_reason: z.string().max(12000).optional(),
    kinds: descriptions.optional(),
    match_note: z.string().max(12000).optional(),
    sources: descriptions.optional()
}).strict();

export function parseLedger(text) {
    const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
    if (typeof text !== 'string') throw invalid('台帳 JSON を入力してください。');
    if (new TextEncoder().encode(text).length > MAX_LEDGER_BYTES) throw invalid('台帳 JSON は 1 MiB 以下にしてください。', 413);
    let data;
    try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { throw invalid('JSON の書式を確認してください。'); }
    const result = ledger.safeParse(data);
    if (!result.success) {
        const path = result.error.issues[0].path.join('.') || 'ルート';
        throw invalid(`台帳の項目が無効です: ${path}（directives は 1〜500 件）`);
    }
    const ids = new Set();
    for (const { id } of result.data.directives) {
        if (ids.has(id)) throw invalid(`台帳内で指示 ID が重複しています: ${id}`);
        ids.add(id);
    }
    return result.data;
}

export const directiveKinds = { forbid: '禁止', require: '必須', rule: 'ルール', exercise: '演習', fact: '事実', reference: '参考' };
