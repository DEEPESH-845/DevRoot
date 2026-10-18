import { GraphScene } from './scene';
import type { ActionPlan, BlastRadius, Candidate, Drill, GraphData, Result, SceneState, TraceStep } from './types';

type View = 'overview' | 'investigation' | 'drills' | 'history';
type RunState = 'idle' | 'running' | 'done' | 'error';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STEP_MS = reducedMotion ? 0 : 700;
const SEV_ORDER = ['SEV-1', 'SEV-2', 'SEV-3', 'SEV-4'];

let view: View = 'overview';
let base: GraphData | null = null;
let health: { nodes: number; edges: number } | null = null;
let scene: GraphScene | null = null;
let scenes: SceneState[] = [];
let cursor = 0;
let result: Result | null = null;
let trace: TraceStep[] = [];
let run: RunState = 'idle';
let runError: { code: string; message: string } | null = null;
let timer = 0;
let es: EventSource | null = null;
let drill: Drill | null = null;
let plan: ActionPlan | null = null;
let tab = 'cand';
let query = '';
let incidentId: string | null = null;
let memory: (Result['prior_investigations'][number] & { incident: string })[] = [];
let crit: { id: string; betweenness: number; pagerank: number }[] = [];
let overlayLabel = '';

// ------------------------------------------------------------------ helpers
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const ref = (id: string) => `<button class="ref" data-id="${esc(id)}">${esc(id)}</button>`;
/** Escape, then turn [ID] references into buttons that focus the real graph entity. */
const refs = (s: string) => esc(s).replace(/\[([A-Za-z]+-[\w.-]+)\]/g, (_, id) => ref(id));
const hhmm = (at: string) => at?.slice(11, 16) ?? '';
const clock = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16);
const svcName = (id: string) => base?.services.find(s => s.id === id)?.name ?? id;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init && { ...init, headers: { 'Content-Type': 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body?.detail?.message ?? `${r.status} ${r.statusText}`), { code: body?.detail?.code, status: r.status });
  return body as T;
}
const announce = (t: string) => { $('#live').textContent = t; };

// ------------------------------------------------------------------ boot & data
async function boot() {
  try {
    scene = new GraphScene($('#canvas'), { onPick: id => (id ? inspect(id) : closeInspector()), onHover: hover, reducedMotion });
  } catch {
    scene = null;
    const fb = $('#fallback');
    fb.hidden = false;
    fb.innerHTML = `<b>WebGL is unavailable in this browser.</b><p class="meta">Investigations, evidence, replay and actions still work in the panel; only the graph drawing is off.</p>`;
  }
  await refreshAll();
  scene?.fit();
  route();
}

async function refreshAll() {
  try {
    [base, health, crit] = await Promise.all([api<GraphData>('/api/graph'), api<{ nodes: number; edges: number }>('/api/health'), api<typeof crit>('/api/criticality')]);
    scene?.setBase(base);
    scene?.apply(scenes.slice(0, cursor));
    await loadMemory();
  } catch (e) {
    health = null;
    runError = { code: 'graph_unavailable', message: (e as Error).message };
  }
  renderStatus();
}

async function refreshBase() {
  base = await api<GraphData>('/api/graph');
  scene?.setBase(base);
  scene?.apply(scenes.slice(0, cursor));
}

async function loadMemory() {
  const ids = (base?.incidents ?? []).map(i => i.id);
  memory = (await Promise.all(ids.map(id => api<Result['prior_investigations']>(`/api/investigations?incident=${id}`).catch(() => []))))
    .flatMap((rows, i) => rows.map(r => ({ ...r, incident: ids[i] }))).sort((a, b) => b.ts - a.ts);
  $('#nav-history').textContent = memory.length ? String(memory.length) : '';
}

function renderStatus() {
  $('#status').innerHTML = health
    ? `<span><i class="dot ok"></i>FalkorDB connected</span><span>${health.nodes} nodes, ${health.edges} relationships</span>
       <span>${base?.services.length ?? 0} services, ${base?.incidents.length ?? 0} open incidents</span>
       <span title="GPU particle status">Particles: ${esc(scene?.particlesStatus ?? 'off (no WebGL)')}</span>`
    : `<span><i class="dot bad"></i>FalkorDB unavailable</span><span>Investigations are disabled until the graph is reachable.</span>`;
}

// ------------------------------------------------------------------ routing
function route() {
  const v = (location.hash.replace('#/', '') || 'overview') as View;
  view = (['overview', 'investigation', 'drills', 'history'] as View[]).includes(v) ? v : 'overview';
  document.querySelectorAll<HTMLAnchorElement>('.nav a').forEach(a => {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  render();
}
function go(v: View) { if (location.hash !== `#/${v}`) location.hash = `#/${v}`; else route(); }

function render() { renderHeader(); renderPanel(); renderPhase(); renderTransport(); }

// ------------------------------------------------------------------ header
function topIncident() {
  return [...(base?.incidents ?? [])].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity))[0];
}

function renderHeader() {
  const h = $('#header');
  if (view === 'overview') {
    const top = topIncident();
    h.innerHTML = `<div class="titles"><h1><span class="t">System overview</span></h1>
      <p class="sub">${base ? `${base.services.length} services and ${base.incidents.length} open incidents, read live from FalkorDB.` : 'Waiting for the graph.'}</p></div>
      <div class="tools">${top ? `<button class="btn primary" data-investigate="${esc(top.id)}">Investigate ${esc(top.id)}</button>` : ''}
      <button class="btn" data-explore="1">Explore service graph</button></div>`;
  } else if (view === 'investigation') {
    const inc = result?.incident ?? base?.incidents.find(i => i.id === incidentId);
    const sev = inc ? `<span class="badge sev-${esc(inc.severity)}">${esc(inc.severity)}</span>` : '';
    const status = run === 'running' ? '<span class="badge active">Investigating</span>'
      : run === 'error' ? '<span class="badge critical">Stopped</span>'
      : result ? (result.evidence_status === 'supported' ? '<span class="badge hypothesis">Hypothesis</span>' : '<span class="badge neutral">Insufficient evidence</span>') : '';
    const where = result ? `Alerts on ${result.symptoms.map(svcName).join(' and ')}. Started ${hhmm(result.incident.at)} UTC on ${result.incident.at.slice(0, 10)}.`
      : inc ? `Started ${hhmm(String(inc.at))} UTC. The investigation traces it through the graph.` : 'Describe the problem or pick an incident.';
    h.innerHTML = `<div class="titles"><h1>${sev}<span class="t">${inc ? `${esc(inc.id)} ${esc(inc.name)}` : 'Investigation'}</span>${status}</h1>
      <p class="sub">${esc(where)}</p></div>
      <form class="tools ask" id="ask"><label class="sr-only" for="q">Investigation request</label>
        <input type="text" id="q" maxlength="500" placeholder="Ask: why is checkout slow?" value="${esc(query)}" />
        <button class="btn primary" type="submit" ${run === 'running' ? 'disabled' : ''}>${run === 'running' ? 'Investigating…' : 'Investigate'}</button></form>`;
  } else if (view === 'drills') {
    h.innerHTML = `<div class="titles"><h1><span class="t">Fire drills</span></h1>
      <p class="sub">Break a service on purpose. The agent investigates without the answer key.</p></div>`;
  } else {
    h.innerHTML = `<div class="titles"><h1><span class="t">History</span></h1>
      <p class="sub">Past investigations and approved actions, as recorded in the graph. Findings stay hypotheses until someone verifies them.</p></div>`;
  }
}

// ------------------------------------------------------------------ context panel
function renderPanel() {
  const p = $('#panel');
  if (!health && runError?.code === 'graph_unavailable') {
    p.innerHTML = `<section><div class="callout error"><b>Graph reasoning unavailable</b>${esc(runError.message)}
      <p class="meta">DevRoot does not answer without FalkorDB. Start it (see README) and reload.</p></div></section>`;
    return;
  }
  if (view === 'overview') p.innerHTML = overviewPanel();
  else if (view === 'investigation') p.innerHTML = investigationPanel();
  else if (view === 'drills') p.innerHTML = drillPanel();
  else { p.innerHTML = historyPanel(); loadActionsList(); }
}

function overviewPanel() {
  const last = (id: string) => memory.find(m => m.incident === id);
  const maxB = Math.max(1, ...crit.map(c => c.betweenness));
  return `<section><h2>Open incidents</h2>
    ${[...(base?.incidents ?? [])].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity)).map(i => {
      const m = last(i.id);
      return `<div class="incident-row" role="button" tabindex="0" data-investigate="${esc(i.id)}">
        <span class="badge sev-${esc(i.severity)}">${esc(i.severity)}</span>
        <span class="tt"><span class="id">${esc(i.id)}</span>${esc(i.name)}</span>
        <span class="btn small">Investigate</span>
        <span class="sub">Started ${hhmm(i.at)} UTC. ${m ? `<span class="hyp">Last hypothesis ${esc(m.top_candidate)} (${m.top_score})</span>, unverified.` : 'Not investigated yet.'}</span></div>`;
    }).join('') || '<p class="meta">No open incidents.</p>'}</section>
    <section><h2>Chokepoints <span class="meta">algo.betweenness</span></h2>
      <p class="lede" style="margin-bottom:10px">Services most dependency paths run through. A failure here reaches the most callers.</p>
      <ul class="choke">${crit.filter(c => c.betweenness > 0).slice(0, 5).map(c => `<li data-id="${esc(c.id)}" tabindex="0" role="button">
        <span class="nm">${esc(svcName(c.id))}</span><span class="b"><i style="width:${(c.betweenness / maxB) * 100}%"></i></span><span class="v">${c.betweenness}</span></li>`).join('')}</ul>
      <p class="meta" style="margin-top:8px">Sampled estimate with a fixed seed. Node size in the graph uses the same score.</p></section>
    <section><h2>How DevRoot answers</h2><p class="lede">Every investigation is a fixed plan of read-only Cypher queries: alert, dependency paths, recent changes,
      matching signals, history. Each conclusion links back to the nodes that produced it.</p></section>`;
}

function investigationPanel() {
  if (run === 'running') {
    return `<section><h2><span class="badge active">Running</span> Live query trace</h2>
      <ol class="live">${scenes.map((s, i) => `<li><span class="n">${i + 1}</span><span>${esc(s.title)}<br><span class="meta">${esc(s.annotation)}</span></span>
        <span class="r">${trace[i] ? `${trace[i].rows} rows` : ''}</span></li>`).join('') || '<li><span class="n">·</span><span>Resolving the incident…</span><span></span></li>'}</ol></section>`;
  }
  if (run === 'error' && runError) {
    const title = runError.code === 'no_incident' ? 'Nothing to investigate' : runError.code === 'graph_unavailable' ? 'Graph reasoning unavailable' : 'Insufficient evidence';
    return `<section><div class="callout ${runError.code === 'graph_unavailable' ? 'error' : 'warn'}"><b>${title}</b>${esc(runError.message)}
      <p class="meta" style="margin-top:6px">DevRoot reports what the graph is missing instead of guessing.</p></div></section><section>${suggestions()}</section>`;
  }
  if (!result) {
    return `<div class="empty"><h2>Start from a symptom</h2>
      <p>Describe what is wrong, or name an incident. DevRoot walks the graph from the alert to the change that explains it, and shows each hop.</p>
      ${suggestions()}</div>`;
  }
  return diagnosis() + tabs();
}

function suggestions() {
  const qs = ['Investigate the payment latency spike after the latest deployment', 'Why is checkout slow? INC-2041',
    'Investigate delayed order notifications', 'Kubernetes etcd quorum loss'];
  return `<div class="suggest">${qs.map(q => `<button data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
}

const TERM_COLORS: Record<string, string> = { temporal: '#8d82cf', reachability: '#3fd0e0', corroboration: '#9de8f0', mechanism: '#f2b04c', history: '#c99a5c' };
const TERM_MAX: Record<string, number> = { temporal: 20, reachability: 20, corroboration: 30, mechanism: 20, history: 10 };
const termBar = (c: Candidate) => `<div class="bar" role="img" aria-label="${Object.entries(c.terms).map(([k, v]) => `${k} ${v} of ${TERM_MAX[k]}`).join(', ')}">
  ${Object.entries(c.terms).map(([k, v]) => `<i style="width:${v}%;background:${TERM_COLORS[k]}"></i>`).join('')}</div>`;

function chainHtml(): string {
  if (!result?.evidence_chain.length) return '';
  const kind = (id: string) => id.startsWith('ALR') ? 'alert' : id.startsWith('CFG') ? 'config' : id.startsWith('DEP') ? 'change'
    : id.startsWith('fm-') ? 'fm' : /^(MET|LOG)/.test(id) ? 'signal' : 'svc';
  const hop = (id: string, label = id) => `<button class="hop k-${kind(id)}" data-id="${esc(id)}" title="${esc(id)}">${esc(label)}</button>`;
  const rel = (t: string) => `<span class="rel">${t}</span>`;
  const rows = result.evidence_chain.filter((r, i, a) => a.findIndex(x => x.element === r.element) === i).slice(0, 2);
  const first = rows[0];
  const svcs = first.path.slice(0, -1);
  const head = [hop(first.alert), rel('FIRED_ON'), ...svcs.flatMap((s, i) => [hop(s, svcName(s)), rel(i < svcs.length - 1 ? 'DEPENDS_ON' : 'DEPLOYED_TO ←')]),
    hop(first.path[first.path.length - 1])].join('');
  const tails = rows.map(r => [rel('SHIPS'), hop(r.element), rel('TOUCHES'), hop(r.fm, r.fm.replace('fm-', '')), rel('← INDICATES'),
    ...r.signals.map(s => hop(s))].join('')).join('<span style="flex-basis:100%;height:2px"></span>');
  return `<div class="chain" aria-label="Evidence path from alert to cause">${head}${tails}</div>
    <p class="chain-caption">One Cypher query returned this path. <button class="btn ghost small" data-chain="1">Show on graph</button></p>`;
}

function diagnosis(): string {
  const r = result!, top = r.candidates[0];
  const supported = r.evidence_status === 'supported';
  const mins = Math.round((r.incident.ts - top.ts) / 60);
  const matched = top.supporting.filter(s => s.includes('INDICATES')).length;
  const history = top.supporting.find(s => s.startsWith('[INC-'));
  const reasons = [
    top.reach && top.explains_symptom ? `<li class="pro"><span class="m">+</span><span>Synchronously reachable from the alert: ${top.reach.path.map(svcName).map(esc).join(' → ')}.</span></li>` : '',
    matched ? `<li class="pro"><span class="m">+</span><span>${matched} observed signals indicate a mechanism this change touches.</span></li>` : '',
    history ? `<li class="pro"><span class="m">+</span><span>${refs(history.split(';')[0])}.</span></li>` : '',
    ...top.contradicting.slice(0, 2).map(c => `<li class="con"><span class="m">−</span><span>${refs(c)}</span></li>`),
    ...top.unknowns.slice(0, 2).map(u => `<li class="unk"><span class="m">?</span><span>${refs(u)}</span></li>`),
  ].join('');
  const runner = r.candidates[1];
  return `<section class="verdict">
    <div class="state">${supported ? '<span class="badge hypothesis">Leading hypothesis</span> <span class="meta">supported by graph evidence, not verified</span>'
      : '<span class="badge neutral">Insufficient evidence</span> <span class="meta">no candidate meets the evidence bar</span>'}</div>
    <h1>${ref(top.id)} ${esc(top.name)}</h1>
    <p class="where">${top.label === 'Deployment' ? 'Deployed to' : 'Applied to'} ${esc(top.service_name)} at ${hhmm(top.at)} UTC,
      ${mins >= 0 ? `${mins} min before the incident started` : `${-mins} min after the incident started`}.</p>
    <div class="score"><span class="num">${top.score}<small>/100</small></span>${termBar(top)}
      <div class="terms">${Object.entries(top.terms).map(([k, v]) => `<span><i style="background:${TERM_COLORS[k]}"></i>${k} ${v}</span>`).join('')}
      <span class="note">Heuristic evidence score, not a probability.${runner ? ` Runner-up ${esc(runner.id)} scored ${runner.score}.` : ''}</span></div></div>
    ${chainHtml()}
    <ul class="reasons">${reasons}</ul>
    <p class="next"><b>Verify next.</b> ${refs(top.next_step)}</p>
    <div class="row"><button class="btn" data-blast="${esc(top.service)}">Blast radius</button>
      <button class="btn" data-rollback="${esc(top.id)}">Preview rollback</button>
      <button class="btn ghost" data-tab-go="act">Proposed actions</button></div>
    ${drill && drill.incident_id === r.incident.id ? `<div class="drill-check ${top.id === drill.injected_cause ? 'ok' : 'bad'}">
      ${top.id === drill.injected_cause ? '✓' : '✗'} Fire drill: ranked ${esc(top.id)} first; the injected cause was ${esc(drill.injected_cause)}.
      ${drill.decoy ? `The decoy ${esc(drill.decoy)} was closer in time and was rejected because no dependency path reaches it.` : ''}</div>` : ''}
  </section>`;
}

function tabs(): string {
  const r = result!;
  const T: [string, string, number | string][] = [['cand', 'Candidates', r.candidates.length], ['ev', 'Evidence', r.evidence.length],
    ['blast', 'Blast radius', r.blast_radius.services.length], ['act', 'Actions', plan?.actions.length ?? ''], ['q', 'Queries', trace.length]];
  const body = tab === 'cand' ? candidatesTab() : tab === 'ev' ? evidenceTab() : tab === 'blast' ? blastTab(r.blast_radius) : tab === 'act' ? actionsTab() : queriesTab();
  return `<div class="tabs" role="tablist" aria-label="Investigation details">${T.map(([k, l, c]) =>
    `<button role="tab" id="tab-${k}" data-tab="${k}" aria-selected="${tab === k}" tabindex="${tab === k ? 0 : -1}">${l}<span class="c">${c}</span></button>`).join('')}</div>
    <div class="tabpanel" role="tabpanel" aria-labelledby="tab-${tab}">${body}</div>`;
}

function candidatesTab() {
  return result!.candidates.map(c => `<div class="cand ${c.rank === 1 ? 'lead' : ''}">
    <div class="top"><span class="rank">#${c.rank}</span>${ref(c.id)}<span class="nm">${esc(c.name)}</span><span class="sc">${c.score}</span></div>
    ${termBar(c)}
    <p class="why">${esc(c.service_name)}, ${hhmm(c.at)} UTC. ${c.explains_symptom ? 'On a synchronous path from the alert.' : '<span class="neg">No synchronous path to the alert.</span>'}</p>
    <details><summary>Evidence for and against (${c.supporting.length + c.contradicting.length + c.unknowns.length})</summary><ul>
      ${c.supporting.map(x => `<li class="pro">${refs(x)}</li>`).join('')}${c.contradicting.map(x => `<li class="con">${refs(x)}</li>`).join('')}
      ${c.ruled_out.map(x => `<li>${refs(x)}</li>`).join('')}${c.unknowns.map(x => `<li class="unk">${refs(x)}</li>`).join('')}</ul>
      <div class="row"><button class="btn small" data-path="${esc(c.id)}">Show path</button><button class="btn small" data-blast="${esc(c.service)}">Blast radius</button></div>
    </details></div>`).join('');
}

const STANCE: Record<string, string> = { supports: 'supports', 'supports-other': 'other cause', context: 'context', symptom: 'symptom', hypothesis: 'hypothesis', candidate: 'candidate' };
function evidenceTab() {
  return `<p class="meta" style="margin-bottom:8px">Every row is a node returned by FalkorDB. Select one to focus it in the graph.</p>
    <ul class="ledger">${result!.evidence.map(e => `<li data-focus="${esc(e.id)}" tabindex="0">
      <span class="tm">${hhmm(e.at)}</span>
      <span class="d"><span class="k k-${esc(e.kind)}">${esc(e.id)}</span> ${esc(e.detail)}<span class="rl">${esc(e.relation)}</span></span>
      <span class="stance s-${esc(e.stance)}">${esc(STANCE[e.stance] ?? e.stance)}</span></li>`).join('')}</ul>`;
}

function blastTab(br: BlastRadius) {
  return `<p class="lede">${br.services.length} services depend on ${ref(br.origin)} within 4 hops, ${br.services.filter(s => s.impact === 'direct').length} directly.
    Exposure, not a confirmed outage.</p>
    <ul class="list" style="margin-top:8px">${br.services.map(s => `<li><span>${ref(s.id)} <span class="muted">${esc(s.name)}</span></span>
      <span class="impact ${esc(s.impact.split(' ')[0])}">${esc(s.impact)}</span>
      <span class="sub">${s.hops} hop${s.hops > 1 ? 's' : ''}: ${s.path.map(svcName).map(esc).join(' → ')}${s.betweenness ? `. Chokepoint score ${s.betweenness}` : ''}</span></li>`).join('')}</ul>
    <div class="row"><button class="btn small" data-blast="${esc(br.origin)}">Show propagation</button></div>`;
}

function actionsTab() {
  if (!plan) return '<p class="meta">Loading proposed actions…</p>';
  return `${plan.actions.map(a => `<div class="act"><h3>${esc(a.name)}</h3>
    ${a.recorded ? `<span class="recorded">✓ recorded ${esc(a.recorded.id)}</span>` : `<button class="btn small" data-approve="${esc(a.type)}" data-vid="${esc(plan!.investigation_id)}">Approve and record</button>`}
    <p>${esc(a.rationale)}</p><div class="tg">${a.targets.map(ref).join('')}</div></div>`).join('')}
    <p class="meta" style="margin-top:10px">${esc(plan.note)}</p>`;
}

function queriesTab() {
  return `<p class="meta" style="margin-bottom:8px">${trace.length} read-only queries (GRAPH.RO_QUERY), parameters bound, every traversal capped at 4 hops.</p>` +
    trace.map(t => `<details class="q"><summary><span>${t.step}. ${esc(t.query)}</span><span>${t.rows} rows, ${t.ms} ms</span></summary>
      <pre>${esc(t.cypher)}</pre><pre class="params">${esc(JSON.stringify(t.params))}</pre></details>`).join('');
}

function drillPanel() {
  const opts = (base?.services ?? []).filter(s => s.kind === 'service')
    .map(s => `<option value="${esc(s.id)}" ${s.id === 'svc-ledger' ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  return `<section><h2>Inject an incident</h2><div class="form">
      <label for="drill-svc">Service to break</label><select id="drill-svc">${opts}</select>
      <label for="drill-fm">Failure mechanism</label><select id="drill-fm"><option value="fm-pool-exhaustion">Connection-pool exhaustion</option><option value="fm-retry-storm">Retry amplification</option></select>
      <div class="row" style="margin-top:4px"><button class="btn primary" id="drill-go">Inject and investigate</button><button class="btn" id="drill-reset">Remove drills</button></div>
      <p class="meta" id="drill-msg" aria-live="polite">${drill ? `Last drill: ${esc(drill.incident_id)}, alert on ${esc(svcName(drill.symptom_service))}.` : ''}</p></div></section>
    <section><h2>What gets written</h2><ul class="reasons">
      <li class="pro"><span class="m">1</span><span>A deployment on the chosen service that ships a config change touching the mechanism.</span></li>
      <li class="pro"><span class="m">2</span><span>A metric and a log on that service indicating the mechanism.</span></li>
      <li class="pro"><span class="m">3</span><span>An alert on its nearest synchronous caller, picked by a graph query. That is where the symptom shows up.</span></li>
      <li class="unk"><span class="m">4</span><span>A decoy change, closer in time, on a service the symptom cannot reach.</span></li></ul>
      <p class="meta" style="margin-top:10px">Drill data is labelled synthetic/drill and is removed with one click. The seed graph is never modified.</p></section>`;
}

function historyPanel() {
  return `<section><h2>Investigations <span class="meta">${memory.length}</span></h2><ul class="list">
    ${memory.slice(0, 12).map(m => `<li><span><button class="ref" data-inv="${esc(m.id)}">${esc(m.id)}</button> ${esc(m.incident)}</span>
      <span class="badge hypothesis">${esc(m.top_candidate)} ${m.top_score}</span>
      <span class="sub">${new Date(m.ts * 1000).toLocaleString()}. ${esc(m.query || '(no query text)')}</span></li>`).join('') || '<li class="meta">No investigations yet.</li>'}</ul></section>
    <section><h2>Approved actions</h2><div id="actions-list"><p class="meta">Loading…</p></div></section>`;
}

async function loadActionsList() {
  try {
    const rows = await api<{ id: string; type: string; name: string; status: string; ts: number; targets: string[] }[]>('/api/actions');
    const box = document.getElementById('actions-list');
    if (!box) return;
    box.innerHTML = rows.length ? `<ul class="list">${rows.map(a => `<li><span>${esc(a.name)}</span><span class="${a.status === 'recorded' ? 'recorded' : 'meta'}">${esc(a.status)}</span>
      <span class="sub">${a.targets.map(ref).join(' ')}</span></li>`).join('')}</ul>
      ${rows.some(a => a.type === 'freeze_deploys' && a.status === 'recorded') ? '<div class="row"><button class="btn" data-lift="1">Lift all freezes</button></div>' : ''}`
      : '<p class="meta">No actions recorded. Approve one from an investigation.</p>';
  } catch (e) { const b = document.getElementById('actions-list'); if (b) b.textContent = (e as Error).message; }
}

// ------------------------------------------------------------------ phase line + transport
function renderPhase() {
  const s = scenes[cursor - 1];
  const el = $('#phase-line');
  const [label, text] = overlayLabel.split('|');
  if (overlayLabel) el.innerHTML = `<span class="badge active">${esc(label)}</span><span>${esc(text ?? '')}</span>`;
  // the queries finish in milliseconds; once the result is in, the canvas is replaying recorded state, and says so
  else if (s) el.innerHTML = `<span class="badge ${s.phase === 'complete' ? 'hypothesis' : 'active'}">${result ? 'Replay' : 'Query'} ${s.seq} of ${scenes.length}</span><span>${esc(s.title)}</span>`;
  else el.innerHTML = `<span class="meta">${base ? 'Service graph. Node size shows how many dependency paths run through a service.' : ''}</span>`;
}

function renderTransport() {
  $('#steps').innerHTML = scenes.map((s, i) => `<li><button data-step="${i + 1}" class="${i < cursor - 1 ? 'done' : ''} ${i === cursor - 1 ? 'cur' : ''}"
    title="${esc(s.title)}" aria-label="Step ${s.seq}: ${esc(s.title)}" ${i === cursor - 1 ? 'aria-current="step"' : ''}>${esc(s.phase)}</button></li>`).join('');
  ($('#r-prev') as HTMLButtonElement).disabled = cursor <= 1;
  ($('#r-next') as HTMLButtonElement).disabled = cursor >= scenes.length;
  ($('#r-play') as HTMLButtonElement).disabled = !scenes.length || run === 'running';
  renderTime();
}

let scrubT: number | null = null;
function renderTime() {
  const box = $('#time');
  if (!result) {
    box.className = 'time empty';
    box.textContent = run === 'running' ? 'The timeline appears when the investigation completes.' : 'Run an investigation to replay it here and scrub through the incident timeline.';
    return;
  }
  const items = result.evidence;
  const t0 = Math.min(...items.map(i => i.ts)), t1 = Math.max(...items.map(i => i.ts), result.incident.ts);
  const x = (ts: number) => `${((ts - t0) / Math.max(t1 - t0, 1)) * 100}%`;
  const T = scrubT ?? t1;
  box.className = 'time';
  box.innerHTML = `<div class="track"></div><span class="onset" style="left:${x(result.incident.ts)}" title="Incident start ${hhmm(result.incident.at)} UTC"></span>
    ${items.map(e => `<button class="tick k-${esc(e.kind)} s-${esc(e.stance)} ${e.ts > T ? 'future' : ''}" style="left:${x(e.ts)}" data-focus="${esc(e.id)}"
      title="${esc(`${hhmm(e.at)} ${e.id}: ${e.detail}`)}" aria-label="${esc(`${hhmm(e.at)} UTC, ${e.kind} ${e.id}`)}"></button>`).join('')}
    <input type="range" id="scrub" min="${t0}" max="${t1}" step="60" value="${T}" aria-label="Show the graph as it was at a point in time" aria-valuetext="${clock(T)} UTC">
    <div class="labels"><span>${clock(t0)}</span><span class="now">${scrubT === null ? `Drag to time-travel. Incident started ${hhmm(result.incident.at)} UTC` : timeLabel(T)}</span><span>${clock(t1)}</span></div>`;
  ($('#scrub') as HTMLInputElement).addEventListener('input', e => scrubTo(Number((e.target as HTMLInputElement).value)));
}

function timeLabel(T: number) {
  const live = result!.evidence.filter(e => e.ts <= T);
  const n = (k: string[]) => live.filter(e => k.includes(e.kind)).length;
  const rel = T < result!.incident.ts ? `${Math.round((result!.incident.ts - T) / 60)} min before onset` : 'after onset';
  return `${clock(T)} UTC, ${rel}: ${n(['change'])} changes, ${n(['metric', 'log'])} signals, ${n(['alert'])} alerts`;
}

/** Temporal view: only events recorded at or before T, drawn on the real edges that connect them to their service. */
function scrubTo(T: number) {
  if (!result) return;
  stopTimer();
  cursor = scenes.length;
  scrubT = T;
  const live = result.evidence.filter(e => e.ts <= T);
  scene?.apply(scenes, { path: live.map(e => [e.id, e.service] as [string, string]), focus: [...new Set(live.flatMap(e => [e.id, e.service]))],
    particles: T >= result.incident.ts ? 'blast' : 'trace' });
  overlayLabel = `Time travel|Graph as recorded at ${clock(T)} UTC`;
  document.querySelectorAll<HTMLElement>('.time .tick').forEach(el => {
    const e = result!.evidence.find(x => x.id === el.dataset.focus);
    el.classList.toggle('future', !!e && e.ts > T);
  });
  $('.time .labels .now').textContent = timeLabel(T);
  renderPhase();
}

// ------------------------------------------------------------------ investigation stream
function investigate(q: string) {
  if (run === 'running') return; // no duplicate requests
  es?.close(); stopTimer();
  query = q; scenes = []; cursor = 0; result = null; trace = []; plan = null; runError = null; scrubT = null; overlayLabel = ''; tab = 'cand';
  run = 'running';
  $('#inspector').hidden = true;
  scene?.select(null);
  scene?.apply([]);
  if (view !== 'investigation') go('investigation'); else render();

  es = new EventSource(`/api/investigate?q=${encodeURIComponent(q)}`);
  es.addEventListener('step', ev => {
    const d = JSON.parse((ev as MessageEvent).data) as { scene: SceneState; trace: TraceStep | null };
    scenes.push(d.scene);
    if (d.trace && !trace.some(t => t.step === d.trace!.step)) trace.push(d.trace);
    if (d.scene.phase === 'context') { incidentId = d.scene.title.match(/INC-\d+/)?.[0] ?? incidentId; renderHeader(); }
    if (view === 'investigation') renderPanel();
    renderTransport();
    if (!timer) timer = window.setInterval(advance, STEP_MS || 1);
  });
  es.addEventListener('result', ev => {
    result = JSON.parse((ev as MessageEvent).data) as Result;
    trace = result.trace; incidentId = result.incident.id;
    es?.close(); es = null;
    run = 'done';
    const top = result.candidates[0];
    announce(`Leading hypothesis ${top.id}, ${top.name}, score ${top.score} of 100, ${result.evidence_status === 'supported' ? 'supported by graph evidence but not verified' : 'insufficient evidence'}.`);
    render();
    loadPlan(result.investigation_id);
    loadMemory();
  });
  es.addEventListener('error', ev => {
    const data = (ev as MessageEvent).data;
    es?.close(); es = null;
    if (run === 'done') return;
    stopTimer();
    run = 'error';
    runError = data ? JSON.parse(data) : { code: 'graph_unavailable', message: 'The investigation stream was interrupted before a result arrived.' };
    if (runError!.code === 'graph_unavailable') { health = null; renderStatus(); }
    overlayLabel = '';
    render();
    announce(runError!.message);
  });
}

function stopTimer() { clearInterval(timer); timer = 0; }
function advance() { if (cursor >= scenes.length) { stopTimer(); return; } show(cursor + 1); }

function show(n: number) {
  cursor = Math.max(0, Math.min(n, scenes.length));
  overlayLabel = ''; scrubT = null;
  scene?.apply(scenes.slice(0, cursor));
  const s = scenes[cursor - 1];
  if (s) announce(`${s.title}. ${s.annotation}`);
  renderPhase(); renderTransport();
}

function replay() { stopTimer(); show(1); timer = window.setInterval(advance, Math.max(STEP_MS, 800)); }

async function loadPlan(vid: string) {
  try { plan = await api<ActionPlan>(`/api/actions/plan/${encodeURIComponent(vid)}`); } catch { plan = null; }
  if (view === 'investigation' && result) renderPanel();
}

// ------------------------------------------------------------------ graph interactions
function hover(id: string | null, x: number, y: number) {
  const card = $('#hovercard');
  const d = id ? scene?.describe(id) : null;
  if (!d) { card.hidden = true; return; }
  const kind = d.label === 'Service' ? d.kind : d.label;
  card.hidden = false;
  card.style.left = `${Math.min(x, card.parentElement!.clientWidth - 300)}px`;
  card.style.top = `${y}px`;
  card.innerHTML = `<b>${esc(d.label === 'Service' ? d.name : d.id)}</b>${esc(d.label === 'Service' ? d.id : d.name)}<br>
    ${esc(kind)}${d.alert ? ', alerting' : ''}${d.frozen ? ', deploys frozen' : ''}. Click to inspect.`;
}

function edgesOf(id: string): [string, string][] {
  const out: [string, string][] = [];
  for (const s of scenes.slice(0, cursor)) for (const [a, b] of s.edges) if (a === id || b === id) out.push([a, b]);
  for (const d of base?.dependencies ?? []) if (d.src === id || d.dst === id) out.push([d.src, d.dst]);
  return out;
}

async function inspect(id: string) {
  scene?.select(id);
  scene?.apply(scenes.slice(0, cursor), { path: edgesOf(id), focus: [id], particles: 'trace' });
  overlayLabel = `Neighbourhood|${id} and its direct relationships`;
  renderPhase();
  const box = $('#inspector');
  box.hidden = false;
  box.innerHTML = `<p class="meta">Loading ${esc(id)}…</p>`;
  try {
    const e = await api<{ node: Record<string, unknown>; labels: string[]; neighbors: { type: string; out: boolean; id: string; name: string; label: string }[] }>(`/api/entity/${encodeURIComponent(id)}`);
    const props = Object.entries(e.node).filter(([k]) => !['id', 'name', 'source', 'record', 'ts'].includes(k));
    box.innerHTML = `<button class="x" aria-label="Close inspector">×</button>
      <p class="meta">${e.labels.map(esc).join(', ')}</p><h3>${esc(e.node.name ?? e.node.id)}</h3><p class="id muted">${esc(e.node.id)}</p>
      <dl>${props.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(Array.isArray(v) ? v.join('; ') : v)}</dd>`).join('')}</dl>
      <p class="meta">Source: ${esc(e.node.source)}</p>
      <h2 style="font:var(--t-panel);margin:14px 0 6px">Relationships <span class="meta">${e.neighbors.length}</span></h2>
      <ul class="rels">${e.neighbors.map(n => `<li><span class="rt">${n.out ? `−${esc(n.type)}→` : `←${esc(n.type)}−`}</span>${ref(n.id)}</li>`).join('')}</ul>
      <div class="row">${e.labels.includes('Service') ? `<button class="btn small" data-blast="${esc(id)}">Blast radius</button>` : ''}
        ${e.labels.includes('Change') ? `<button class="btn small" data-rollback="${esc(id)}">Preview rollback</button>` : ''}</div>`;
  } catch (err) {
    box.innerHTML = `<button class="x" aria-label="Close inspector">×</button><div class="callout error"><b>Not found</b>${esc((err as Error).message)}</div>`;
  }
}

function closeInspector() {
  if ($('#inspector').hidden && !overlayLabel) return;
  $('#inspector').hidden = true;
  overlayLabel = ''; scrubT = null;
  scene?.select(null);
  scene?.apply(scenes.slice(0, cursor));
  renderPhase();
  renderTime();
}

async function showBlast(sid: string) {
  try {
    const br = await api<BlastRadius>(`/api/blast-radius/${encodeURIComponent(sid)}`);
    scene?.apply(scenes.slice(0, cursor), { path: br.edges, focus: [sid, ...br.services.map(s => s.id)], particles: 'blast' });
    overlayLabel = `Blast radius|${br.services.length} services depend on ${svcName(sid)}; propagation runs along DEPENDS_ON in reverse`;
    renderPhase();
    if (result && view === 'investigation') {
      result.blast_radius = { ...br, services: br.services.map(s => ({ ...s, betweenness: crit.find(c => c.id === s.id)?.betweenness })) };
      tab = 'blast'; renderPanel();
    }
    announce(`${br.services.length} services depend on ${sid}.`);
  } catch (e) { overlayLabel = `Error|${(e as Error).message}`; renderPhase(); }
}

function showPath(cid: string) {
  const c = result?.candidates.find(x => x.id === cid);
  if (!c) return;
  const p = c.reach ? [...c.reach.path, c.id] : [c.service, c.id];
  scene?.apply(scenes.slice(0, cursor), { path: p.slice(1).map((b, i) => [p[i], b] as [string, string]), focus: [cid], particles: c.explains_symptom ? 'converge' : 'trace' });
  overlayLabel = `Path|${c.reach ? p.map(svcName).join(' → ') : `${cid} has no dependency path from the alert`}`;
  renderPhase();
}

function showChain() {
  if (!result) return;
  const path: [string, string][] = [];
  for (const r of result.evidence_chain.slice(0, 2)) {
    const nodes = [r.alert, ...r.path];
    nodes.slice(1).forEach((b, i) => path.push([nodes[i], b]));
    path.push([r.path[r.path.length - 1], r.element], [r.element, r.fm], ...r.signals.map(s => [s, r.fm] as [string, string]));
  }
  scene?.apply(scenes.slice(0, cursor), { path, focus: [result.top], particles: 'converge' });
  overlayLabel = 'Evidence path|Alert to cause, then the mechanism and the signals that indicate it';
  renderPhase();
}

async function showRollback(cid: string) {
  const dlg = $('#rollback') as HTMLDialogElement;
  $('#rb-body').innerHTML = '<p class="meta">Loading…</p>';
  dlg.showModal();
  try {
    const p = await api<any>(`/api/rollback-preview/${encodeURIComponent(cid)}`);
    $('#rb-body').innerHTML = `<div class="callout info"><b>Preview only. Nothing is executed.</b>This lists what a rollback would change, according to the graph.</div>
      <h2 id="rb-title">Roll back ${esc(cid)}, ${esc(p.change.name)}</h2>
      <h4>Would revert</h4><ul>${p.reverts.map((r: any) => `<li><span class="id">${esc(r.id)}</span> ${esc(r.name)}${r.restores ? `, restoring <span class="id">${esc(r.restores)}</span>` : ' <span style="color:var(--hypothesis)">(code change, reverted too)</span>'}</li>`).join('')}</ul>
      <h4>Restart exposure</h4><ul>${p.restart_affects.map((s: any) => `<li>${esc(s.name)} <span class="meta">${esc(s.impact)}</span></li>`).join('')}</ul>
      <h4>Re-check afterwards</h4><p class="id">${p.signals_to_recheck.map(esc).join(', ') || 'No signals recorded.'}</p>
      <h4>Validation</h4><ul>${p.validation.map((v: string) => `<li>${refs(v)}</li>`).join('') || '<li>No tests recorded.</li>'}</ul>
      <h4>Unknowns</h4><ul>${p.unknowns.map((u: string) => `<li>${esc(u)}</li>`).join('')}</ul>`;
  } catch (e) { $('#rb-body').innerHTML = `<div class="callout error"><b>Preview failed</b>${esc((e as Error).message)}</div>`; }
}

async function loadInvestigation(id: string) {
  try {
    const r = await api<Result>(`/api/investigations/${encodeURIComponent(id)}`);
    stopTimer();
    result = r; scenes = r.scenes; trace = r.trace; run = 'done'; runError = null; incidentId = r.incident.id; query = r.intent.text; scrubT = null; tab = 'cand';
    go('investigation');
    loadPlan(r.investigation_id);
    replay();
  } catch (e) { announce((e as Error).message); }
}

async function approve(type: string, vid: string) {
  try {
    const r = await api<{ id: string; targets: number }>('/api/actions', { method: 'POST', body: JSON.stringify({ investigation_id: vid, type }) });
    announce(`Recorded ${r.id} targeting ${r.targets} graph entities.`);
    await loadPlan(vid);
    if (type === 'freeze_deploys') await refreshBase();
  } catch (e) { announce((e as Error).message); }
}

async function runDrill() {
  const msg = $('#drill-msg');
  const body = JSON.stringify({ service_id: ($('#drill-svc') as HTMLSelectElement).value, mechanism: ($('#drill-fm') as HTMLSelectElement).value });
  msg.textContent = 'Writing the drill into FalkorDB…';
  try {
    drill = await api<Drill>('/api/drills', { method: 'POST', body });
    await refreshAll();
    investigate(`Investigate ${drill.incident_id}`);
  } catch (e) { msg.textContent = (e as Error).message; }
}

async function resetDrills() {
  const r = await api<{ deleted: number }>('/api/drills', { method: 'DELETE' }).catch(() => ({ deleted: 0 }));
  drill = null;
  if (result?.incident.id.startsWith('INC-9')) { result = null; scenes = []; cursor = 0; run = 'idle'; }
  await refreshAll();
  render();
  $('#drill-msg').textContent = `Removed ${r.deleted} drill nodes. The seed graph is unchanged.`;
}

function setPixel(on: boolean) {
  document.body.classList.toggle('pixel', on);
  $('#pixel').setAttribute('aria-pressed', String(on));
  scene?.setPixelStream(on, scenes.slice(0, cursor));
  if (on && scenes.length) replay();
}

// ------------------------------------------------------------------ events
window.addEventListener('hashchange', route);
document.addEventListener('submit', e => {
  if ((e.target as HTMLElement).id !== 'ask') return;
  e.preventDefault();
  const q = ($('#q') as HTMLInputElement).value.trim();
  if (q) investigate(q);
});
$('#r-prev').addEventListener('click', () => { stopTimer(); show(cursor - 1); });
$('#r-next').addEventListener('click', () => { stopTimer(); show(cursor + 1); });
$('#r-play').addEventListener('click', replay);
$('#fit').addEventListener('click', () => scene?.fit());
$('#reset').addEventListener('click', () => { closeInspector(); scene?.apply(scenes.slice(0, cursor)); scene?.fit(); });
$('#pixel').addEventListener('click', () => setPixel(!document.body.classList.contains('pixel')));
$('#canvas-wrap').addEventListener('pointerleave', () => { $('#hovercard').hidden = true; });

document.addEventListener('click', e => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('button, [data-investigate], [data-focus], li[data-id]');
  if (!t || t.closest('#r-prev, #r-next, #r-play, #fit, #reset, #pixel')) return;
  const d = t.dataset;
  if (d.approve) approve(d.approve, d.vid!);
  else if (d.lift) api('/api/actions/lift-freezes', { method: 'POST' }).then(async () => { await refreshBase(); renderPanel(); if (result) loadPlan(result.investigation_id); });
  else if (t.id === 'drill-go') runDrill();
  else if (t.id === 'drill-reset') resetDrills();
  else if (d.investigate) investigate(`Investigate ${d.investigate}`);
  else if (d.explore) { closeInspector(); scene?.fit(); }
  else if (d.q) investigate(d.q);
  else if (d.inv) loadInvestigation(d.inv);
  else if (d.blast) showBlast(d.blast);
  else if (d.rollback) showRollback(d.rollback);
  else if (d.path) showPath(d.path);
  else if (d.chain) showChain();
  else if (d.step) { stopTimer(); show(Number(d.step)); }
  else if (d.tab) { tab = d.tab; renderPanel(); (document.getElementById(`tab-${tab}`) as HTMLElement | null)?.focus(); }
  else if (d.tabGo) { tab = d.tabGo; renderPanel(); }
  else if (t.classList.contains('x')) closeInspector();
  else if (d.id || d.focus) inspect((d.id ?? d.focus)!);
});

document.addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (t.matches('[role=tab]') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    const tabsEl = [...document.querySelectorAll<HTMLElement>('[role=tab]')];
    const i = tabsEl.indexOf(t) + (e.key === 'ArrowRight' ? 1 : -1);
    tabsEl[(i + tabsEl.length) % tabsEl.length].click();
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter' && t.matches('[data-focus], [data-investigate], li[data-id]')) { t.click(); return; }
  if (t.closest('input, textarea, select')) return;
  if (e.key === '/' && view === 'investigation') { e.preventDefault(); ($('#q') as HTMLInputElement | null)?.focus(); }
  if (e.key === 'ArrowLeft' && cursor > 1) { stopTimer(); show(cursor - 1); }
  if (e.key === 'ArrowRight' && cursor < scenes.length) { stopTimer(); show(cursor + 1); }
  if (e.key === 'Escape') closeInspector();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stopTimer(); });
window.addEventListener('pagehide', () => { es?.close(); stopTimer(); scene?.dispose(); });

boot();
