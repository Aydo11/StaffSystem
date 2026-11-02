// Reads an uploaded spreadsheet (.xlsx, .xlsm or .csv) into plain rows of text, so a person or the AI can read it.
// .xlsx is a zip of XML files; Node's zlib inflates the entries, so no library is needed. Macros are never run or read.
import { inflateRawSync } from 'node:zlib';
import { parseCsv } from './csv.ts';
import { bad } from './http.ts';

const ent = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as any)[e.toLowerCase()]);
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

function unzip(b: Buffer) {
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw bad('This file is not a readable Excel workbook. Save it as .xlsx or .csv and try again.');
  const files = new Map<string, Buffer>();
  let o = b.readUInt32LE(eocd + 16);
  for (let i = 0, n = b.readUInt16LE(eocd + 10); i < n; i++) {
    const method = b.readUInt16LE(o + 10), size = b.readUInt32LE(o + 20), nl = b.readUInt16LE(o + 28), xl = b.readUInt16LE(o + 30), cl = b.readUInt16LE(o + 32), at = b.readUInt32LE(o + 42);
    const name = b.toString('utf8', o + 46, o + 46 + nl);
    const start = at + 30 + b.readUInt16LE(at + 26) + b.readUInt16LE(at + 28), raw = b.subarray(start, start + size);
    if (/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(name)) files.set(name, method === 8 ? inflateRawSync(raw) : raw);
    o += 46 + nl + xl + cl;
  }
  return files;
}

// Excel stores dates as day numbers; a cell is a date when its style uses a date format.
const DATE_IDS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 50, 57]);
const serialDate = (v: number) => new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000)).toISOString().slice(0, 10);
const colNo = (ref: string) => [...ref.replace(/\d+$/, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

export function readXlsx(buf: Buffer): { name: string; rows: string[][] }[] {
  const f = unzip(buf), xml = (n: string) => f.get(n)?.toString('utf8') ?? '';
  const shared = [...xml('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => ent([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const styles = xml('xl/styles.xml');
  const custom = new Map([...styles.matchAll(/<numFmt\b[^>]*>/g)].map((m) => [Number(attr(m[0], 'numFmtId')), ent(attr(m[0], 'formatCode') ?? '')]));
  const isDate = [...(styles.match(/<cellXfs[\s\S]*?<\/cellXfs>/)?.[0] ?? '').matchAll(/<xf\b[^>]*>/g)].map((m) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0), code = custom.get(id);
    return DATE_IDS.has(id) || (!!code && /[dy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, '')));
  });
  const rels = new Map([...xml('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  return [...xml('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const target = (rels.get(attr(m[0], 'r:id')) ?? '').replace(/^\/?(xl\/)?/, '');
    const rows = [...xml(`xl/${target}`).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
      const out: string[] = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const t = attr(c[1], 't'), s = Number(attr(c[1], 's') ?? 0), v = c[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const val = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? ent([...(c[2] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''))
          : v == null ? '' : t === 'str' || t === 'e' ? ent(v) : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : isDate[s] ? serialDate(Number(v)) : v;
        const ref = attr(c[1], 'r');
        out[ref ? colNo(ref) : out.length] = val;
      }
      return Array.from(out, (x) => x ?? '');
    }).filter((r) => r.some((x) => x.trim() !== ''));
    return { name: ent(attr(m[0], 'name') ?? 'Sheet'), rows };
  });
}

// Any accepted spreadsheet as text: one block per sheet, tab-separated, capped so a huge file cannot run up the AI bill.
export function sheetText(buf: Buffer, filename: string, maxChars = 120_000) {
  const isZip = buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (!isZip && buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) throw bad('This is an old-style .xls file. Open it in Excel and save it as .xlsx (Excel Workbook), then upload that.');
  const sheets = isZip ? readXlsx(buf) : [{ name: filename, rows: parseCsv(buf.toString('utf8')) }];
  let text = sheets.filter((s) => s.rows.length).map((s) => `## Sheet: ${s.name}\n${s.rows.map((r) => r.join('\t')).join('\n')}`).join('\n\n');
  if (!text.trim()) throw bad('The file has no rows.');
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  return { text, truncated };
}
