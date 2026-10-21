// "My story": only the person writes it; they choose who reads it, photos included.
import { beforeEach, describe, expect, it } from 'vitest';
import { as, P, resetDb } from './helpers.ts';

beforeEach(resetDb);
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');
const story = `/api/people/${P.sam}/story`;

describe('my story', () => {
  it('the person writes chapters in order; others cannot write', async () => {
    const sam = await as('sam');
    const a = await sam.post(`${story}/chapters`).send({ title: 'Growing up', period: '1990s', body: 'Where I learned to look after people.' });
    const b = await sam.post(`${story}/chapters`).send({ title: 'Why this work', body: 'What brought me to supported housing.' });
    expect(a.status).toBe(201);
    expect((await sam.post(`${story}/order`).send({ ids: [b.body.id, a.body.id] })).status).toBe(200);
    expect((await sam.get(story)).body.chapters.map((c: any) => c.title)).toEqual(['Why this work', 'Growing up']);
    expect((await sam.post(`${story}/chapters`).send({ title: '', body: '' })).status).toBe(400);
    expect((await (await as('morgan')).post(`${story}/chapters`).send({ title: 'x', body: 'y' })).status).toBe(403);
  });

  it('readers follow the chosen visibility, including chapter photos', async () => {
    const sam = await as('sam');
    const c = await sam.post(`${story}/chapters`).send({ title: 'First job', body: 'Night shifts and good mentors.' });
    await sam.post(`${story}/chapters/${c.body.id}/photo`).attach('file', png, 'me.png');
    const photo = (await sam.get(story)).body.chapters[0].photo_file_id;
    const morgan = await as('morgan'), taylor = await as('taylor');
    // Default: managers and HR only.
    expect((await morgan.get(story)).body.shared).toBe(true);
    expect((await taylor.get(story)).body.shared).toBe(false);
    expect((await taylor.get(`/api/files/${photo}`)).status).toBe(404);
    await sam.put(story).send({ visibility: 'colleagues', intro: 'A little about me.' });
    expect((await taylor.get(story)).body).toMatchObject({ shared: true, intro: 'A little about me.' });
    expect((await taylor.get(`/api/files/${photo}`)).status).toBe(200);
    await sam.put(story).send({ visibility: 'private' });
    expect((await morgan.get(story)).body.shared).toBe(false);
    expect((await morgan.get(`/api/files/${photo}`)).status).toBe(404);
    expect((await sam.get(story)).body.shared).toBe(true);
  });
});
