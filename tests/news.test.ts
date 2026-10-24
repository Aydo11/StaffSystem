// News: cover and gallery photos, the article view, and drafts staying private until published.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { as, C, pool, resetDb } from './helpers.ts';

beforeEach(resetDb);
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');

describe('news', () => {
  it('adds Valor information with current publication dates without inventing operational records', async () => {
    const count = async () => (await pool.query('select (select count(*) from meetings)::int meetings, (select count(*) from visits)::int visits, (select count(*) from decisions)::int decisions')).rows[0];
    const before = await count();
    const migration = readFileSync(new URL('../db/migrations/027_valor_company_information.sql', import.meta.url), 'utf8');
    await pool.query(migration);
    await pool.query(migration);
    const posts = (await pool.query("select * from news_posts where title in ('Valor Housing: who we are and how we work', 'Our operating history from August 2026', 'Fortnightly meetings: a practical guide for the team')")).rows;
    expect(posts).toHaveLength(3);
    expect(posts.every(p => p.company_ids.length === 1 && p.company_ids[0] === C.VH)).toBe(true);
    expect(posts.every(p => p.summary.length <= 300 && Date.now() - new Date(p.published_at).getTime() < 60000)).toBe(true);
    expect(await count()).toEqual(before);
  });
  it('publishes welcome guides with local covers and preserves staff edits to sample posts', async () => {
    // In production the previous migration and company records already exist.
    const samples = readFileSync(new URL('../db/migrations/017_news.sql', import.meta.url), 'utf8');
    await pool.query(samples.slice(samples.indexOf('insert into news_posts')));
    await pool.query("update news_posts set body = 'Our own revised guidance.' where title = 'Sample: Chat is here'");
    await pool.query('alter table news_posts drop column cover_asset');
    await pool.query(readFileSync(new URL('../db/migrations/025_staff_welcome_news.sql', import.meta.url), 'utf8'));
    const sam = await as('sam');
    const posts = (await sam.get('/api/news')).body;
    const guides = posts.filter((p: any) => p.cover_asset);
    expect(guides).toHaveLength(6);
    expect(guides.filter((p: any) => p.pinned).map((p: any) => p.title)).toEqual(['Welcome to your Hub: start here']);
    for (const guide of guides) {
      expect(guide.company_ids.sort()).toEqual(Object.values(C).sort());
      expect(guide.summary.length).toBeLessThanOrEqual(300);
      expect(guide.image_alt.length).toBeGreaterThan(10);
      expect(existsSync(new URL(`../web/public/images/news/${guide.cover_asset}.png`, import.meta.url))).toBe(true);
      const article = (await sam.get(`/api/news/${guide.id}`)).body;
      expect(article.body).toBe(guide.body);
    }
    expect(posts.filter((p: any) => p.title.startsWith('Sample:')).map((p: any) => p.title)).toEqual(['Sample: Chat is here']);
  });
  it('a publisher adds a cover and gallery; readers see them once published', async () => {
    const priya = await as('priya');
    const n = (await priya.post('/api/news').send({ company_ids: [C.VH], category: 'update', title: 'Garden clear-up', summary: 'Before and after.', body: 'We cleared the garden.' })).body;
    expect(n.summary).toBe('Before and after.');
    expect((await priya.post(`/api/news/${n.id}/image`).field('image_alt', 'The cleared garden').attach('file', png, 'cover.png')).status).toBe(201);
    const g = (await priya.post(`/api/news/${n.id}/photos`).attach('file', png, 'after.png')).body;
    const sam = await as('sam');
    expect((await sam.get(`/api/news/${n.id}`)).status).toBe(404); // draft
    expect((await sam.get(`/api/files/${g.id}`)).status).toBe(404);
    await priya.post(`/api/news/${n.id}/publish`);
    const seen = (await sam.get(`/api/news/${n.id}`)).body;
    expect(seen.photos).toEqual([{ id: g.id, original_name: 'after.png' }]); // the cover is not repeated in the gallery
    expect((await sam.get(`/api/files/${g.id}`)).status).toBe(200);
    expect((await sam.post(`/api/news/${n.id}/photos`).attach('file', png, 'x.png')).status).toBe(404);
    // Replacing the cover removes the old one rather than leaving it in the gallery.
    await priya.post(`/api/news/${n.id}/image`).field('image_alt', 'A new cover').attach('file', png, 'cover2.png');
    expect((await sam.get(`/api/news/${n.id}`)).body.photos).toHaveLength(1);
    expect((await priya.del(`/api/news/${n.id}/photos/${g.id}`)).status).toBe(200);
    expect((await sam.get(`/api/news/${n.id}`)).body.photos).toEqual([]);
  });
});
