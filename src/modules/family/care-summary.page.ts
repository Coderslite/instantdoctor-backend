import { escapeHtml as e } from '../../integrations/mail/layout.js';
import type { CareSummary } from './care-summary.service.js';

const fmtDate = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const fmtDateTime = (d: Date | string) =>
  new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const KIND: Record<string, string> = { hypertension: 'Blood pressure', diabetes: 'Diabetes', general: 'General care' };
const RELATION: Record<string, string> = {
  self: 'Account holder',
  spouse: 'Spouse',
  child: 'Child',
  parent: 'Parent',
  sibling: 'Sibling',
  grandparent: 'Grandparent',
  other: 'Family member',
};

const reading = (r: CareSummary['carePlans'][number]['recentReadings'][number]) =>
  r.glucose !== null ? `${r.glucose} mg/dL` : `${r.systolic}/${r.diastolic} mmHg`;

const row = (label: string, value: string | null | undefined) =>
  `<div class="row"><span>${e(label)}</span><strong>${value ? e(value) : '—'}</strong></div>`;

/** Self-contained, print-friendly page a clinician can open without the app. */
export function renderCareSummaryPage(data: { summary: CareSummary; sharedBy: string | null; expiresAt: Date }) {
  const { person, medications, carePlans, labResults, generatedAt } = data.summary;
  const facts = [
    person.age !== null ? `${person.age} yrs` : null,
    person.sex ? person.sex[0]!.toUpperCase() + person.sex.slice(1) : null,
    RELATION[person.relationship] ?? null,
  ].filter(Boolean);

  const meds = medications.length
    ? medications
        .map(
          (m) => `<li><strong>${e(m.name)}</strong>${m.times.length ? ` · ${e(m.times.join(', '))}` : ''}
            ${m.instructions ? `<div class="muted">${e(m.instructions)}</div>` : ''}
            <div class="muted">Until ${e(fmtDate(m.until))}</div></li>`,
        )
        .join('')
    : '<li class="muted">No active medication recorded.</li>';

  const plans = carePlans.length
    ? carePlans
        .map((p) => {
          const s = p.last30Days;
          const average =
            s.averageGlucose !== null
              ? `${s.averageGlucose} mg/dL`
              : s.averageSystolic !== null
                ? `${s.averageSystolic}/${s.averageDiastolic} mmHg`
                : '—';
          const recent = p.recentReadings.length
            ? `<table><tr><th>Reading</th><th>When</th><th>Context</th></tr>${p.recentReadings
                .map(
                  (r) =>
                    `<tr><td><strong>${e(reading(r))}</strong>${r.note ? `<div class="muted">${e(r.note)}</div>` : ''}</td><td>${e(fmtDateTime(r.measuredAt))}</td><td>${e(r.context ?? '—')}</td></tr>`,
                )
                .join('')}</table>`
            : '<p class="muted">No readings in the last 30 days.</p>';
          return `<div class="card">
            <div class="eyebrow">${e(KIND[p.kind] ?? p.kind)}</div>
            <h3>${e(p.name)}</h3>
            <div class="grid">${row('30-day average', average)}${row('Readings (30 days)', String(s.count))}${row('Next review', fmtDate(p.nextReviewAt))}</div>
            ${p.notes ? `<p class="muted">${e(p.notes)}</p>` : ''}
            ${recent}
          </div>`;
        })
        .join('')
    : '<p class="muted">No active care plans.</p>';

  const labs = labResults.length
    ? `<h2>Recent lab results</h2>${labResults
        .map(
          (l) =>
            `<div class="card"><h3>${e(l.testName ?? 'Lab result')}</h3><div class="muted">${e(fmtDate(l.resultDate))}</div>${l.interpretation ? `<p>${e(l.interpretation)}</p>` : ''}</div>`,
        )
        .join('')}`
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Care summary — ${e(person.name)}</title>
<style>
  :root { --ink:#0F2744; --muted:#5E7A99; --line:#E1E8F0; --brand:#008CFF; --danger:#DC2626; --bg:#F6FAFF; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  main { max-width:760px; margin:0 auto; padding:28px 18px 48px; }
  header { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
  h1 { margin:6px 0 2px; font-size:28px; letter-spacing:-.5px; }
  h2 { margin:28px 0 10px; font-size:18px; }
  h3 { margin:2px 0 8px; font-size:16px; }
  .brand { color:var(--brand); font-weight:800; font-size:13px; letter-spacing:.6px; text-transform:uppercase; }
  .muted { color:var(--muted); font-size:13px; }
  .eyebrow { color:var(--brand); font-size:11px; font-weight:800; letter-spacing:.7px; text-transform:uppercase; }
  .card { background:#fff; border:1px solid var(--line); border-radius:16px; padding:16px 18px; margin-bottom:12px; }
  .alert { border-color:#FCA5A5; background:#FEF2F2; }
  .alert strong { color:var(--danger); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:4px 18px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:6px 0; border-bottom:1px solid var(--line); font-size:14px; }
  .row span { color:var(--muted); }
  ul { margin:0; padding-left:18px; } li { margin:6px 0; }
  table { width:100%; border-collapse:collapse; margin-top:8px; font-size:14px; }
  th { text-align:left; color:var(--muted); font-weight:600; font-size:12px; padding:6px 4px; border-bottom:1px solid var(--line); }
  td { padding:8px 4px; border-bottom:1px solid var(--line); vertical-align:top; }
  footer { margin-top:28px; color:var(--muted); font-size:12px; }
  @media print { body { background:#fff; } .card { break-inside:avoid; } }
</style></head>
<body><main>
  <header>
    <div>
      <div class="brand">Instant Doctor · Care summary</div>
      <h1>${e(person.name)}</h1>
      <div class="muted">${e(facts.join(' · '))}</div>
    </div>
    <div class="muted" style="text-align:right">Generated<br>${e(fmtDateTime(generatedAt))}</div>
  </header>

  <h2>Key information</h2>
  <div class="card ${person.allergies ? 'alert' : ''}">
    <div class="row"><span>Allergies</span><strong>${person.allergies ? e(person.allergies) : 'None recorded'}</strong></div>
    ${row('Conditions', person.conditions)}
    ${row('Blood group', person.bloodGroup)}
    ${row('Genotype', person.genotype)}
  </div>

  <h2>Current medication</h2>
  <div class="card"><ul>${meds}</ul></div>

  <h2>Monitoring</h2>
  ${plans}
  ${labs}

  <footer>
    Shared ${data.sharedBy ? `by ${e(data.sharedBy)} ` : ''}with their consent via Instant Doctor. This link expires on ${e(fmtDateTime(data.expiresAt))}.<br>
    Readings and history are entered by the patient or caregiver and should be confirmed clinically.
  </footer>
</main></body></html>`;
}
