import test from 'node:test';
import assert from 'node:assert/strict';
import { graphUrl, importThreads } from '../server/teams.js';
import { emptyState, demoUsers } from '../shared/domain.js';
test('Graph pagination cannot send credentials to another host',()=>{
 assert.throws(()=>graphUrl('https://evil.example/v1.0/me'));
 assert.throws(()=>graphUrl('https://graph.microsoft.com/beta/me'));
 assert.equal(graphUrl('me/joinedTeams'),'https://graph.microsoft.com/v1.0/me/joinedTeams');
});
test('Import retains replies and provenance, remains unapproved, and deduplicates',()=>{
 const r={payload:emptyState()};
 const threads=[{id:'123',body:{content:'<b>design discussion</b>'},replies:[{id:'456',body:{content:'reply'}}]}];
 assert.deepEqual(importThreads(r,demoUsers[0],demoUsers,'t','c',threads),{imported:1,skipped:0});
 assert.equal(r.payload.raw[0].source.messages.length,2);
 assert.match(r.payload.raw[0].text,/reply/);
 assert.equal(r.payload.cards[0].status,'draft');
 assert.equal(r.payload.cards[0].resolved,false);
 assert.deepEqual(importThreads(r,demoUsers[0],demoUsers,'t','c',threads),{imported:0,skipped:1});
 assert.throws(()=>importThreads({payload:emptyState()},demoUsers[3],demoUsers,'t','c',threads));
});
