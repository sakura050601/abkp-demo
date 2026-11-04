import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { authConfig, companyEmail, digest } from './auth.js';
import { emptyState } from '../shared/domain.js';

const { values } = parseArgs({
    options: {
        email: { type: 'string' }, nickname: { type: 'string' }, role: { type: 'string', default: 'viewer' },
        project: { type: 'string' }, 'verified-by': { type: 'string' }, recover: { type: 'boolean', default: false },
        init: { type: 'boolean', default: false }, 'workspace-name': { type: 'string', default: '設計事業部' }
    }
});
if (process.env.DEMO_MODE === 'true') throw new Error('Invitations require DEMO_MODE=false');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Configure server-only Supabase credentials');
const config = authConfig();
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
if (values.init) {
    const name = z.string().trim().min(1).max(100).parse(values['workspace-name']);
    let { data: project, error } = await db.from('projects').select('id').eq('is_default', true).maybeSingle();
    if (error) throw new Error(error.message);
    if (!project) {
        const inserted = await db.from('projects').insert({ name, is_default: true }).select('id').single();
        if (inserted.error) throw new Error(inserted.error.message);
        project = inserted.data;
    }
    const state = await db.from('project_states').upsert({ project_id: project.id, revision: 0, payload: emptyState() }, { onConflict: 'project_id', ignoreDuplicates: true });
    if (state.error) throw new Error(state.error.message);
    console.log(`Workspace ready: ${project.id}. Existing data was preserved; no demo accounts were created.`);
} else {
    const input = z.object({ email: companyEmail, nickname: z.string().trim().min(1).max(60).optional(), role: z.enum(['designer', 'senior', 'viewer']), project: z.uuid().optional(), 'verified-by': z.string().trim().min(3).max(200), recover: z.boolean() }).parse(values);
    if (!input.recover && !input.nickname) throw new Error('--nickname is required for invitations');
    const token = randomBytes(32).toString('base64url');
    const { error } = await db.rpc('auth_issue_grant', {
        p_email: input.email, p_nickname: input.nickname || '', p_project_id: input.project || null,
        p_role: input.role, p_purpose: input.recover ? 'recover' : 'enroll', p_token_hash: digest(token), p_verified_by: input['verified-by']
    });
    if (error) throw new Error(error.message);
    console.log(input.recover ? 'Recovery issued. All old passkeys and sessions are revoked.' : 'Invitation issued after operator identity verification.');
    console.log(`Recipient: ${input.email}`);
    console.log('Send the link privately using your existing company email. No email has been sent automatically.');
    console.log('Single use; expires in 30 minutes. Deliver privately to the verified person:');
    console.log(`${config.origin}/#enroll=${token}`);
}