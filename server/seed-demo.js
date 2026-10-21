import { createClient } from '@supabase/supabase-js';
import { hashPassword } from './passwords.js';
import { seed } from '../shared/domain.js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before seeding.');

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const accounts = [
    { key: 'author', nickname: '藤井 美咲', email: 'author@example.test', role: 'designer' },
    { key: 'reviewer', nickname: '田中 健一', email: 'reviewer@example.test', role: 'designer' },
    { key: 'senior', nickname: '佐藤 直樹', email: 'senior@example.test', role: 'senior' },
    { key: 'viewer', nickname: '山本 葵', email: 'viewer@example.test', role: 'viewer' }
];
const fail = (error) => { if (error) throw error; };

let { data: project, error } = await db.from('projects').select('id').eq('is_default', true).maybeSingle();
fail(error);
if (!project) {
    ({ data: project, error } = await db.from('projects').insert({ name: '設計事業部', is_default: true }).select('id').single());
    fail(error);
}

const users = {};
const created = [];
for (const account of accounts) {
    let result = await db.from('app_users').select('id').eq('email', account.email).maybeSingle();
    fail(result.error);
    if (result.data) {
        users[account.key] = result.data;
    } else {
        result = await db.from('app_users').insert({ nickname: account.nickname, email: account.email, password_hash: await hashPassword('knowledge-demo') }).select('id').single();
        fail(result.error);
        users[account.key] = result.data;
        created.push(account.email);
    }
    const membership = await db.from('memberships').upsert({ project_id: project.id, user_id: users[account.key].id, display_name: account.nickname, role: account.role }, { onConflict: 'project_id,user_id' });
    fail(membership.error);
}

let state = await db.from('project_states').select('revision,payload').eq('project_id', project.id).maybeSingle();
fail(state.error);
const hasData = state.data && Object.values(state.data.payload || {}).some(value => Array.isArray(value) && value.length);
if (!state.data || !hasData) {
    const payload = seed();
    for (const raw of payload.raw) raw.owner = users.author.id;
    for (const card of payload.cards) card.owner = users.author.id;
    if (state.data) {
        const update = await db.from('project_states').update({ revision: 0, payload }).eq('project_id', project.id);
        fail(update.error);
    } else {
        const insert = await db.from('project_states').insert({ project_id: project.id, revision: 0, payload });
        fail(insert.error);
    }
}

console.log(`Demo workspace ready (${project.id}).`);
console.log(`New demo accounts: ${created.length ? created.join(', ') : 'none; existing accounts were kept'}`);
console.log('Password for newly created demo accounts: knowledge-demo');
