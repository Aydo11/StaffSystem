// Staff documents (CVs), visit photos and assigning staff from a property.
import { beforeEach, describe, expect, it } from 'vitest';
import { A, as, P, prop, resetDb, V } from './helpers.ts';

beforeEach(resetDb);
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');
const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....word/document.xml....')]);

describe('staff documents', () => {
  it('the person uploads a CV; HR can open it, colleagues cannot', async () => {
    const sam = await as('sam');
    const up = await sam.post(`/api/people/${P.sam}/documents`).attach('file', docx, 'Sam CV.docx');
    expect(up.status).toBe(201);
    expect(up.body.mime_type).toContain('wordprocessingml');
    expect((await sam.get(`/api/people/${P.sam}`)).body.documents.map((d: any) => d.id)).toEqual([up.body.id]);
    expect((await (await as('morgan')).get(`/api/files/${up.body.id}`)).status).toBe(200);
    expect((await (await as('taylor')).get(`/api/files/${up.body.id}`)).status).toBe(404);
    expect((await (await as('priya')).get(`/api/people/${P.sam}`)).body.documents).toBeNull(); // managers without staff.edit
  });
  it('refuses other people’s profiles without staff.edit, and non-document content', async () => {
    expect((await (await as('taylor')).post(`/api/people/${P.sam}/documents`).attach('file', png, 'x.png')).status).toBe(403);
    expect((await (await as('sam')).post(`/api/people/${P.sam}/documents`).attach('file', Buffer.from('PK\x03\x04 not word'), 'cv.docx')).status).toBe(400);
  });
  it('HR can remove a document; the person cannot remove one HR added', async () => {
    const morgan = await as('morgan');
    const up = await morgan.post(`/api/people/${P.sam}/documents`).attach('file', png, 'reference.png');
    expect((await (await as('sam')).del(`/api/people/${P.sam}/documents/${up.body.id}`)).status).toBe(403);
    expect((await morgan.del(`/api/people/${P.sam}/documents/${up.body.id}`)).status).toBe(200);
    expect((await morgan.get(`/api/people/${P.sam}`)).body.documents).toEqual([]);
  });
});

describe('visit photos', () => {
  it('the worker adds photos; they show on the visit and on the property', async () => {
    const sam = await as('sam');
    const up = await sam.post(`/api/visits/${V.d03}/photos`).attach('file', png, 'hallway.png');
    expect(up.status).toBe(201);
    expect((await sam.get(`/api/visits/${V.d03}`)).body.photos.map((p: any) => p.id)).toEqual([up.body.id]);
    const pr = await (await as('priya')).get(`/api/properties/${prop(2)}`);
    expect(pr.body.photos.map((p: any) => p.id)).toEqual([up.body.id]);
    expect((await (await as('priya')).get(`/api/files/${up.body.id}`)).status).toBe(200);
  });
  it('only images, only the worker or an approver, and approved visits keep their photos', async () => {
    const sam = await as('sam');
    expect((await sam.post(`/api/visits/${V.d03}/photos`).attach('file', Buffer.from('%PDF-1.4'), 'a.pdf')).status).toBe(400);
    expect((await (await as('taylor')).post(`/api/visits/${V.d03}/photos`).attach('file', png, 'x.png')).status).toBe(404);
    const up = await sam.post(`/api/visits/${V.d01}/photos`).attach('file', png, 'after.png');
    expect(up.status).toBe(201);
    expect((await sam.del(`/api/visits/${V.d01}/photos/${up.body.id}`)).status).toBe(409);
  });
});

describe('assigning staff from a property', () => {
  it('lists unallocated appointments and drops them once allocated', async () => {
    const morgan = await as('morgan');
    const list = (await morgan.get(`/api/properties/${prop(1)}/assignable`)).body;
    expect(list.some((x: any) => x.id === A.samVH)).toBe(false); // already allocated in the seed
    const pick = list[0];
    expect((await morgan.post(`/api/appointments/${pick.id}/properties`).send({ property_id: prop(1), override_reason: 'Covering while clearance completes' })).status).toBe(201); // fictional staff have no clearance yet
    expect((await morgan.get(`/api/properties/${prop(1)}/assignable`)).body.some((x: any) => x.id === pick.id)).toBe(false);
    expect((await (await as('priya')).get(`/api/properties/${prop(1)}/assignable`)).body).toEqual([]); // no appointments.manage
  });
});
