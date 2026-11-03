// Chat: photo-only messages, emoji reactions; KPIs for each person in a team.
import { beforeEach, describe, expect, it } from 'vitest';
import { as, C, P, resetDb, rid } from './helpers.ts';

beforeEach(resetDb);
const TEAM = '00000000-0000-4000-8000-000000000f71'; // seeded: Priya and Sam
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');

describe('chat', () => {
  it('sends a photo with no text, but not an empty message', async () => {
    const sam = await as('sam');
    expect((await sam.post(`/api/conversations/${TEAM}/messages`).field('client_request_id', rid()).field('body', '')).status).toBe(400);
    const r = await sam.post(`/api/conversations/${TEAM}/messages`).field('client_request_id', rid()).field('body', '').attach('file', png, 'hall.png');
    expect(r.status).toBe(201);
    const msgs = (await (await as('priya')).get(`/api/conversations/${TEAM}/messages`)).body;
    expect(msgs.messages.at(-1)).toMatchObject({ body: '', file_type: 'image/png', author_id: P.sam });
    expect(msgs.members.map((m: any) => m.id).sort()).toEqual([P.sam, P.priya].sort());
  });
  it('toggles reactions for members only, from the fixed set', async () => {
    const sam = await as('sam');
    const m = await sam.post(`/api/conversations/${TEAM}/messages`).field('client_request_id', rid()).field('body', 'Keys returned');
    const priya = await as('priya');
    expect((await priya.post(`/api/messages/${m.body.id}/reactions`).send({ emoji: '👍' })).body).toEqual({ reacted: true });
    const seen = (await sam.get(`/api/conversations/${TEAM}/messages`)).body.messages.find((x: any) => x.id === m.body.id);
    expect(seen.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    expect((await priya.post(`/api/messages/${m.body.id}/reactions`).send({ emoji: '👍' })).body).toEqual({ reacted: false });
    expect((await priya.post(`/api/messages/${m.body.id}/reactions`).send({ emoji: 'hello' })).status).toBe(400);
    expect((await (await as('taylor')).post(`/api/messages/${m.body.id}/reactions`).send({ emoji: '👍' })).status).toBe(404);
  });
  it('forwards to own chats, and only admins and managers send to everyone', async () => {
    const sam = await as('sam'), alex = await as('alex');
    const m = await sam.post(`/api/conversations/${TEAM}/messages`).field('client_request_id', rid()).field('body', 'Fire alarm test on Friday').attach('file', png, 'alarm.png');
    const dm = (await sam.post('/api/conversations').send({ company_id: C.VH, kind: 'direct', member_ids: [P.priya] })).body.id;
    expect((await sam.post(`/api/messages/${m.body.id}/forward`).send({ conversation_ids: [dm] })).body).toEqual({ sent: 1 });
    const fwd = (await sam.get(`/api/conversations/${dm}/messages`)).body.messages.at(-1);
    expect(fwd).toMatchObject({ body: 'Fire alarm test on Friday', forwarded_from: expect.any(String), file_type: 'image/png' });
    expect(fwd.file_id).not.toBe(m.body.file_id);
    expect((await sam.post(`/api/messages/${m.body.id}/forward`).send({ everyone_company_ids: [C.VH] })).status).toBe(403);
    expect((await (await as('taylor')).post(`/api/messages/${m.body.id}/forward`).send({ conversation_ids: [dm] })).status).toBe(404);
    // Alex is not in the team chat, so forwards from a chat Alex is in.
    const a = await alex.post(`/api/conversations/${dm}/messages`).field('client_request_id', rid()).field('body', 'x');
    expect(a.status).toBe(404);
    const own = (await alex.post('/api/conversations').send({ company_id: C.VH, kind: 'direct', member_ids: [P.sam] })).body.id;
    const am = (await alex.post(`/api/conversations/${own}/messages`).field('client_request_id', rid()).field('body', 'Office closed Monday')).body;
    expect((await alex.post(`/api/messages/${am.id}/forward`).send({ everyone_company_ids: [C.VH] })).status).toBe(201);
    await alex.post(`/api/messages/${am.id}/forward`).send({ everyone_company_ids: [C.VH] });
    const groups = (await sam.get('/api/conversations')).body.filter((c: any) => c.everyone);
    expect(groups).toHaveLength(1);
    const g = (await sam.get(`/api/conversations/${groups[0].id}/messages`)).body;
    expect(g.messages.map((x: any) => x.body)).toEqual(['Office closed Monday', 'Office closed Monday']);
    expect(g.members.map((x: any) => x.id)).toEqual(expect.arrayContaining([P.alex, P.sam, P.priya]));
  });
});

describe('team KPIs', () => {
  it('lists each current person with their own measures, for KPI viewers only', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const rows = (await (await as('morgan')).get(`/api/kpis/team?company=${C.VH}&month=${month}`)).body;
    const sam = rows.find((r: any) => r.id === P.sam);
    expect(sam.kpis.map((k: any) => k.key)).toContain('approved_hours');
    expect((await (await as('sam')).get(`/api/kpis/team?company=${C.VH}&month=${month}`)).status).toBe(403);
  });
});
