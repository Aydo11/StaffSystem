// Monthly figures: type each month's actual totals by line, like a spreadsheet, and the Hub works out revenue, gross
// profit, net profit and margins, and compares them with the budget. A blank cell uses what the records show (grey).
import { Fragment, useMemo, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { api, useApi, useSubmit } from '../api.ts';
import { londonToday } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, ErrorSummary, LoadError, Skeleton, useToast } from '../ui.tsx';
import { csv, save, xlsx } from '../xlsx.ts';
import { CAT } from './FinanceHub.tsx';

const gbp0 = (p: number) => `${p < 0 ? '−' : ''}£${Math.round(Math.abs(p) / 100).toLocaleString('en-GB')}`;
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
const toPence = (s: string) => Math.round(Number(s.replace(/[£,\s]/g, '')) * 100);
const valid = (s: string) => s.trim() === '' || /^£?\d[\d,]*(\.\d{1,2})?$/.test(s.replace(/\s/g, ''));
const monthName = (m: string) => new Date(`${m}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });

export function MonthlyFigures() {
  const hub = useHub();
  const toast = useToast();
  const cos = hub.me.companies.filter((c) => c.perms.includes('finance.view'));
  const [company, setCompany] = useState(hub.company !== 'all' && cos.some((c) => c.id === hub.company) ? hub.company : cos.find((c) => c.code === 'VH')?.id ?? cos[0]?.id);
  const t = londonToday(), thisFy = Number(t.slice(0, 4)) - (t.slice(5, 7) < '04' ? 1 : 0);
  const [fy, setFy] = useState(thisFy);
  const d = useApi<any>(company ? `/finance/monthly?company=${company}&fy=${fy}` : null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const key = (m: string, c: string) => `${m}|${c}`;
  const cell = useMemo(() => new Map<string, any>((d.data?.cells ?? []).map((x: any) => [key(x.month, x.category), x])), [d.data]);

  const saveAll = useSubmit(async () => {
    const cells = Object.entries(edits).map(([k, v]) => { const [month, category] = k.split('|'); return { month, category, amount: v.trim() === '' ? null : (toPence(v) / 100).toFixed(2) }; });
    await api('PUT', '/finance/monthly', { company_id: company, cells });
    setEdits({}); toast(`Saved ${cells.length} figure${cells.length === 1 ? '' : 's'}.`); d.reload();
  });
  if (!company) return <p className="notice">You don't have finance access in any company.</p>;
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={10} />;

  const { months, income, direct, expense, can_edit: canEdit } = d.data as { months: string[]; income: string[]; direct: string[]; expense: string[]; can_edit: boolean };
  const overheads = expense.filter((c) => !direct.includes(c));
  const groups: [string, string[]][] = [['Income', income], ['Direct costs', direct], ['Overheads', overheads]];
  const rows = groups.flatMap(([, cs]) => cs);
  // The figure that counts for a cell: what is being typed, else what was saved, else the records.
  const value = (m: string, c: string) => {
    const e = edits[key(m, c)];
    if (e !== undefined) return e.trim() === '' ? cell.get(key(m, c))?.records ?? 0 : valid(e) ? toPence(e) : 0;
    const x = cell.get(key(m, c));
    return x?.typed ?? x?.records ?? 0;
  };
  const shown = (m: string, c: string) => edits[key(m, c)] ?? (cell.get(key(m, c))?.typed != null ? (cell.get(key(m, c)).typed / 100).toFixed(2) : '');
  const sum = (m: string, cs: string[]) => cs.reduce((s, c) => s + value(m, c), 0);
  const budget = (m: string, cs: string[]) => cs.reduce((s, c) => s + (cell.get(key(m, c))?.budget ?? 0), 0);
  const calc = (m: string) => {
    const rev = sum(m, income), dc = sum(m, direct), oh = sum(m, overheads);
    const bud = budget(m, income) - budget(m, direct) - budget(m, overheads);
    return { rev, dc, gross: rev - dc, oh, net: rev - dc - oh, bud };
  };
  const totals = months.map(calc);
  const year = totals.reduce((a, x) => ({ rev: a.rev + x.rev, dc: a.dc + x.dc, gross: a.gross + x.gross, oh: a.oh + x.oh, net: a.net + x.net, bud: a.bud + x.bud }), { rev: 0, dc: 0, gross: 0, oh: 0, net: 0, bud: 0 });
  const dirty = Object.keys(edits).length, bad = Object.values(edits).some((v) => !valid(v));

  // Keyboard: Enter or ↓ moves down a line, ↑ up; Tab moves across. Pasting a block from Excel fills from this cell.
  const focus = (r: number, c: number) => (document.querySelector(`[data-cell="${r}-${c}"]`) as HTMLInputElement | null)?.focus();
  const onKey = (r: number, c: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); focus(r + 1, c); }
    if (e.key === 'ArrowUp') { e.preventDefault(); focus(r - 1, c); }
  };
  const onPaste = (r: number, c: number) => (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    const next = { ...edits };
    text.replace(/\r/g, '').split('\n').filter((l, i, a) => l !== '' || i < a.length - 1).forEach((line, i) => line.split('\t').forEach((v, j) => {
      const cat = rows[r + i], m = months[c + j];
      if (cat && m) next[key(m, cat)] = v.trim();
    }));
    setEdits(next);
  };
  const copyPrev = (i: number) => {
    const next = { ...edits };
    for (const c of rows) {
      const k = key(months[i], c);
      if (next[k] === undefined && cell.get(k)?.typed == null && !cell.get(k)?.records) { const v = value(months[i - 1], c); if (v) next[k] = (v / 100).toFixed(2); }
    }
    setEdits(next);
  };
  const sheet = () => [['Line', ...months.map(monthName), 'Year'],
    ...groups.flatMap(([g, cs]) => [[g], ...cs.map((c) => [CAT[c], ...months.map((m) => value(m, c) / 100), months.reduce((s, m) => s + value(m, c), 0) / 100])]),
    ['Revenue', ...totals.map((x) => x.rev / 100), year.rev / 100], ['Gross profit', ...totals.map((x) => x.gross / 100), year.gross / 100], ['Net profit', ...totals.map((x) => x.net / 100), year.net / 100], ['Budget net', ...totals.map((x) => x.bud / 100), year.bud / 100]];

  const Total = ({ label: l, get, strong, kind }: { label: string; get: (x: typeof year) => number; strong?: boolean; kind?: 'pct' | 'diff' }) => (
    <tr className={`fm-total ${strong ? 'fm-strong' : ''}`}><th scope="row">{l}</th>
      {totals.map((x, i) => { const v = get(x); return <td key={i} className={`num ${kind !== 'pct' && v < 0 ? 'fh-bad' : ''}`}>{kind === 'pct' ? pct(v, x.rev) : gbp0(v)}</td>; })}
      <td className={`num fm-year ${kind !== 'pct' && get(year) < 0 ? 'fh-bad' : ''}`}>{kind === 'pct' ? pct(get(year), year.rev) : gbp0(get(year))}</td></tr>
  );

  return (
    <>
      <section className="card fm-help">
        <h2>Monthly figures</h2>
        <ol className="fm-steps">
          <li><strong>Type each month's total</strong> for each line, like a spreadsheet. Enter or ↓ moves down; Tab moves across. You can paste a block straight from Excel.</li>
          <li><strong>Blank cells use your records</strong> (invoices, bills and bank items), shown in grey. A typed figure replaces the records for that month and line, so nothing is counted twice.</li>
          <li><strong>The totals work themselves out:</strong> revenue, direct costs, gross profit and margin, overheads, net profit and margin, and the difference from budget.</li>
        </ol>
        <p className="small muted">These figures feed the Overview, Reports and Budget against actual. To change the <em>budget</em> for a month, use Plan &amp; budgets.</p>
      </section>
      <div className="row between fh-toolbar">
        <div className="row">
          {cos.length > 1 && <div className="field" style={{ margin: 0 }}><label htmlFor="fm-co">Company</label><select id="fm-co" value={company} onChange={(e) => { setCompany(e.target.value); setEdits({}); }}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
          <div className="field" style={{ margin: 0 }}><label htmlFor="fm-fy">Financial year</label><select id="fm-fy" value={fy} onChange={(e) => { setFy(Number(e.target.value)); setEdits({}); }}>{[thisFy - 2, thisFy - 1, thisFy, thisFy + 1].map((y) => <option key={y} value={y}>April {y} to March {y + 1}</option>)}</select></div>
        </div>
        <span className="row">
          <Button variant="ghost" onClick={() => save(xlsx([{ name: `Monthly ${fy}`, rows: sheet() }]), `monthly-figures-${fy}.xlsx`)}>Excel</Button>
          <Button variant="ghost" onClick={() => save(csv(sheet()), `monthly-figures-${fy}.csv`)}>CSV</Button>
          {canEdit && dirty > 0 && <Button variant="secondary" onClick={() => setEdits({})}>Undo changes</Button>}
          {canEdit && <Button busy={saveAll.busy} disabled={!dirty || bad} onClick={() => saveAll.run()}>{dirty ? `Save ${dirty} change${dirty === 1 ? '' : 's'}` : 'Saved'}</Button>}
        </span>
      </div>
      <ErrorSummary error={saveAll.error} />
      {bad && <p className="notice warn" role="alert">A highlighted cell isn't a number. Use amounts like 1250 or 1,250.50.</p>}
      <div className="table-wrap fm-grid" tabIndex={-1} role="region" aria-label="Monthly figures grid">
        <table>
          <thead><tr><th scope="col">Line</th>{months.map((m, i) => <th key={m} scope="col" className="num">{monthName(m)}{canEdit && i > 0 && <><br /><button type="button" className="linkish fm-copy" onClick={() => copyPrev(i)} title={`Fill ${monthName(m)}'s empty lines with ${monthName(months[i - 1])}'s figures`}>← copy</button></>}</th>)}<th scope="col" className="num">Year</th></tr></thead>
          <tbody>
            {groups.map(([g, cs], gi) => (
              <Fragment key={g}>
                <tr className="fh-sec"><th colSpan={months.length + 2} scope="rowgroup">{g}</th></tr>
                {cs.map((c) => { const r = rows.indexOf(c); return (
                  <tr key={c}><th scope="row" className="fm-line">{CAT[c]}</th>
                    {months.map((m, i) => { const x = cell.get(key(m, c)), e = edits[key(m, c)], typed = e !== undefined ? e.trim() !== '' : x?.typed != null;
                      const hint = `Records £${((x?.records ?? 0) / 100).toFixed(2)} · Budget £${((x?.budget ?? 0) / 100).toFixed(2)}`;
                      return <td key={m} className="fm-cell">{canEdit
                        ? <input data-cell={`${r}-${i}`} aria-label={`${CAT[c]}, ${monthName(m)}`} title={hint} inputMode="decimal" className={`${typed ? 'fm-typed' : ''} ${e !== undefined ? 'fm-dirty' : ''} ${e !== undefined && !valid(e) ? 'fm-bad' : ''}`}
                            value={shown(m, c)} placeholder={x?.records ? (x.records / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 }) : '0'}
                            onChange={(ev) => setEdits({ ...edits, [key(m, c)]: ev.target.value })} onKeyDown={onKey(r, i)} onPaste={onPaste(r, i)} onFocus={(ev) => ev.target.select()} />
                        : <span title={hint} className={typed ? '' : 'muted'}>{gbp0(value(m, c))}</span>}</td>; })}
                    <td className="num fm-year">{gbp0(months.reduce((s, m) => s + value(m, c), 0))}</td></tr>); })}
                {gi === 0 && <Total label="Revenue" get={(x) => x.rev} strong />}
                {gi === 1 && <><Total label="Direct costs" get={(x) => x.dc} /><Total label="Gross profit" get={(x) => x.gross} strong /><Total label="Gross margin" get={(x) => x.gross} kind="pct" /></>}
                {gi === 2 && <><Total label="Overheads" get={(x) => x.oh} /><Total label="Net profit" get={(x) => x.net} strong /><Total label="Net margin" get={(x) => x.net} kind="pct" />
                  <Total label="Budget net (plan)" get={(x) => x.bud} /><Total label="Net v budget" get={(x) => x.net - x.bud} kind="diff" /></>}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">Grey numbers come from records; dark numbers were typed in; amber cells are not saved yet. Hover a cell to see its records and budget. Clear a cell and save to go back to the records.</p>
    </>
  );
}
