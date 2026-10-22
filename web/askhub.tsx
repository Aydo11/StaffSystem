// "Ask the Hub" on My Day: plain questions about your day, answered by Claude from your own records.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post, useApi, useSubmit } from './api.ts';
import { useHub } from './hub.tsx';
import { Button, ErrorSummary, Field } from './ui.tsx';

const ASK = ['What do I need to do today?', 'Who is off this week?', 'Give me a breakdown of my week', 'What is overdue?'];

export function AskHub() {
  const hub = useHub();
  const meta = useApi<any>('/ai/tasks');
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<any>(null);
  const task = meta.data?.tasks.find((t: any) => t.key === 'ask_hub');
  const on = new Set(meta.data?.companies.filter((c: any) => c.enabled).map((c: any) => c.company_id));
  const company = task?.companies.find((c: string) => on.has(c));
  const ask = useSubmit(async (q?: string) => { const text = (q ?? question).trim(); setQuestion(text); setResult(await post('/ai/runs', { task: 'ask_hub', company_id: company, input: { question: text } })); });
  if (!meta.data) return null;
  return (
    <section className="card ask-hub" aria-labelledby="ask-hub-h">
      <h2 id="ask-hub-h">Ask the Hub</h2>
      {!company ? (
        <p className="muted">The AI assistant is not switched on yet{hub.can('ai.configure') ? <>. <Link to="/admin/ai">Turn it on in AI assistant settings</Link> (the server needs an Anthropic API key first).</> : '. Ask an administrator to turn it on.'}</p>
      ) : <>
        <p className="small muted">Ask about your tasks, planned visits, approvals and who is away. It only uses records you can already see.</p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>{ASK.map((q) => <Button key={q} variant="secondary" disabled={ask.busy} onClick={() => ask.run(q)}>{q}</Button>)}</div>
        <form onSubmit={(e) => { e.preventDefault(); if (question.trim().length >= 3) ask.run(); }}>
          <Field label="Or ask your own question"><input name="question" maxLength={500} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Which of my properties need a visit?" /></Field>
          <Button type="submit" busy={ask.busy} busyText="Thinking…" disabled={question.trim().length < 3}>Ask</Button>
        </form>
        <ErrorSummary error={ask.error} />
        {result && <div className="ask-answer" role="status" style={{ marginTop: 12 }}>
          <p style={{ whiteSpace: 'pre-wrap' }}>{result.output.answer}</p>
          {result.output.key_points?.length > 0 && <ul>{result.output.key_points.map((k: string, i: number) => <li key={i}>{k}</li>)}</ul>}
          {result.output.missing_evidence?.length > 0 && <p className="small muted">Not in the records: {result.output.missing_evidence.join('; ')}</p>}
          <p className="small muted">Written by AI from your records. Check anything important before acting on it.</p>
        </div>}
      </>}
    </section>
  );
}
