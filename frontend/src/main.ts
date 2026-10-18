import { GraphScene } from './scene';
import type { ActionPlan, BlastRadius, Candidate, Drill, GraphData, Result, SceneState, TraceStep } from './types';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STEP_MS = reducedMotion ? 0 : 750;

let base: GraphData | null = null;
let scene: GraphScene | null = null;
let scenes: SceneState[] = [];
let cursor = 0;            // number of scene states currently applied
let result: Result | null = null;
let trace: TraceStep[] = [];
let timer = 0;
let es: EventSource | null = null;
let drill: Drill | null = null;

// ------------------------------------------------------------------ helpers
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** Escape, then turn [ID] references into buttons that focus the real graph entity. */
const refs = (s: string) => esc(s).replace(/\[([A-Za-z]+-[\w.-]+)\]/g, (_, id) => `<button class="ref" data-id="${id}">${id}</button>`);
const hhmm = (at: string) => at?.slice(11, 16) ?? '';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init && { ...init, headers: { 'Content-Type': 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body?.detail?.message ?? r.statusText), { code: body?.detail?.code, status: r.status });
  return body as T;
}

function announce(text: string) { $('#live').textContent = text; }

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    scene = new GraphScene($('#canvas'), { onPick: id => id ? focusEntity(id) : closeEntity(), reducedMotion });
  } catch (e) {
    scene = null;
    const fb = $('#fallback');
    fb.hidden = false;
    fb.innerHTML = `<strong>WebGL unavailable.</strong> The investigation, evidence and replay still work in the panels; only the graph rendering is disabled.`;
  }
  health();
  try {
    base = await api<GraphData>('/api/graph');
    scene?.setBase(base);
    renderIncidents();
    renderDrillForm();
    loadMemory();
  } catch (e) {
    graphDown((e as Error).message);
  }
  if (scene) $('#health').title = `FalkorDB status · particles: ${scene.particlesStatus}`;
}

async function health() {
  try {
    const h = await api<{ nodes: number; edges: number }>('/api/health');
    $('#health').innerHTML = `<i class="ok"></i>FalkorDB · ${h.nodes} nodes · ${h.edges} edges`;
  } catch {
    $('#health').innerHTML = `<i class="bad"></i>FalkorDB unavailable`;
  }
}

function graphDown(msg: string) {
  $('#summary').innerHTML = `<div class="error"><strong>Graph reasoning unavailable.</strong><p>${esc(msg)}</p>
    <p class="muted">DevRoot does not answer without FalkorDB. Start it (see README) and reload.</p></div>`;
}

async function refreshBase() {
  base = await api<GraphData>('/api/graph');
  scene?.setBase(base);
  scene?.apply(scenes.slice(0, cursor));
  renderIncidents();
}

function renderDrillForm() {
  const sel = $('#drill-svc') as HTMLSelectElement;
  sel.innerHTML = (base?.services ?? []).filter(s => s.kind === 'service')
    .map(s => `<option value="${esc(s.id)}" ${s.id === 'svc-ledger' ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
}

async function runDrill() {
  const body = JSON.stringify({ service_id: ($('#drill-svc') as HTMLSelectElement).value, mechanism: ($('#drill-fm') as HTMLSelectElement).value });
  try {
    drill = await api<Drill>('/api/drills', { method: 'POST', body });
    $('#drill-msg').innerHTML = `Injected <strong>${esc(drill.incident_id)}</strong>: alert on ${esc(drill.symptom_service)}${drill.decoy ? ', plus a decoy change closer in time' : ''}. Answer key hidden; investigating…`;
    await refreshBase();
    const q = `Investigate ${drill.incident_id}`;
    ($('#q') as HTMLTextAreaElement).value = q;
    investigate(q);
  } catch (e) { $('#drill-msg').textContent = (e as Error).message; }
}

async function resetDrills() {
  const r = await api<{ deleted: number }>('/api/drills', { method: 'DELETE' }).catch(e => ({ deleted: 0, err: (e as Error).message }));
  drill = null;
  $('#drill-msg').textContent = `Removed ${r.deleted} drill nodes; the seed graph is unchanged.`;
  await refreshBase(); loadMemory();
}

async function loadActions(vid: string) {
  const box = $('#actions-plan');
  if (!box) return;
  try {
    const p = await api<ActionPlan>(`/api/actions/plan/${encodeURIComponent(vid)}`);
    box.innerHTML = `<div class="eyebrow act">Agent actions · require your approval</div>
      ${p.actions.map(a => `<div class="act-row">
        <div><strong>${esc(a.name)}</strong><p class="muted small">${esc(a.rationale)}</p>
          <p class="small">targets: ${a.targets.map(t => `<button class="ref" data-id="${esc(t)}">${esc(t)}</button>`).join(' ')}</p></div>
        ${a.recorded ? `<span class="done-tag">✓ ${esc(a.recorded.id)}</span>`
          : `<button class="approve" data-approve="${esc(a.type)}" data-vid="${esc(vid)}">Approve & record</button>`}</div>`).join('')}
      <p class="muted small">${esc(p.note)} ${p.actions.some(a => a.type === 'freeze_deploys' && a.recorded) ? '<button data-lift="1">Lift freezes</button>' : ''}</p>`;
  } catch (e) { box.innerHTML = `<p class="muted small">${esc((e as Error).message)}</p>`; }
}

async function approve(type: string, vid: string) {
  try {
    const r = await api<{ id: string; targets: number }>('/api/actions', { method: 'POST', body: JSON.stringify({ investigation_id: vid, type }) });
    announce(`Recorded ${r.id} targeting ${r.targets} graph entities.`);
    await loadActions(vid);
    if (type === 'freeze_deploys') await refreshBase();
  } catch (e) { setStatus('Error', (e as Error).message); }
}

function renderIncidents() {
  $('#incidents').innerHTML = (base?.incidents ?? []).map(i => `
    <li><button class="inc" data-inc="${esc(i.id)}"><span class="sev sev-${esc(i.severity)}">${esc(i.severity)}</span>
      <span><strong>${esc(i.id)}</strong> ${esc(i.name)}<br><span class="muted">started ${hhmm(i.at)} UTC · ${esc(i.at.slice(0, 10))}</span></span></button></li>`).join('');
}

async function loadMemory() {
  const ids = (base?.incidents ?? []).map(i => i.id);
  const all = (await Promise.all(ids.map(id => api<Result['prior_investigations']>(`/api/investigations?incident=${id}`).catch(() => []))))
    .flatMap((rows, i) => rows.map(r => ({ ...r, incident: ids[i] })));
  $('#memory').innerHTML = all.length ? all.slice(0, 6).map(r => `
    <li><button class="mem" data-inv="${esc(r.id)}"><span class="mono">${esc(r.id)}</span> → <strong>${esc(r.top_candidate)}</strong> ${r.top_score}
      <br><span class="muted">${esc(r.incident)} · ${new Date(r.ts * 1000).toLocaleTimeString()} · ${esc(r.status)}</span></button></li>`).join('')
    : '<li class="muted">None yet.</li>';
}

// ------------------------------------------------------------------ investigation stream
function investigate(q: string) {
  es?.close(); clearInterval(timer);
  scenes = []; cursor = 0; result = null; trace = [];
  closeEntity();
  scene?.apply([]);
  $('#go').setAttribute('disabled', '');
  $('#summary').innerHTML = `<div class="loading"><span class="pulse"></span>Investigating — each step below is a live Cypher query against FalkorDB.</div>`;
  ['#tab-hyp', '#tab-ev', '#tab-blast'].forEach(s => ($(s).innerHTML = ''));
  renderTrace();
  setStatus('Running', 'Streaming investigation state…');

  es = new EventSource(`/api/investigate?q=${encodeURIComponent(q)}`);
  es.addEventListener('step', ev => {
    const d = JSON.parse((ev as MessageEvent).data) as { scene: SceneState; trace: TraceStep | null };
    scenes.push(d.scene);
    if (d.trace && !trace.some(t => t.step === d.trace!.step)) trace.push(d.trace);
    renderTrace(); renderSteps();
    if (!timer) timer = window.setInterval(advance, STEP_MS || 1);
  });
  es.addEventListener('result', ev => {
    result = JSON.parse((ev as MessageEvent).data) as Result;
    trace = result.trace;
    es?.close(); es = null;
    renderResult(); renderTrace(); loadMemory();
    $('#go').removeAttribute('disabled');
  });
  es.addEventListener('error', ev => {
    const data = (ev as MessageEvent).data;
    es?.close(); es = null;
    $('#go').removeAttribute('disabled');
    if (data) {
      const e = JSON.parse(data) as { code: string; message: string };
      if (e.code === 'graph_unavailable') return graphDown(e.message);
      $('#summary').innerHTML = `<div class="warn"><strong>${e.code === 'no_incident' ? 'Nothing to investigate' : 'Insufficient evidence'}</strong>
        <p>${esc(e.message)}</p><p class="muted">DevRoot reports what the graph is missing instead of guessing.</p></div>`;
      setStatus('Stopped', e.message);
    } else if (!result) {
      api('/api/health').then(() => graphDown('The investigation stream failed.'), err => graphDown((err as Error).message));
      health();
    }
  });
}

function advance() {
  if (cursor >= scenes.length) { clearInterval(timer); timer = 0; return; }
  show(cursor + 1);
}

function show(n: number) {
  cursor = Math.max(0, Math.min(n, scenes.length));
  const prefix = scenes.slice(0, cursor);
  scene?.apply(prefix);
  const s = prefix[prefix.length - 1];
  if (s) { setStatus(`${s.seq}/${scenes.length} · ${s.phase}`, s.title); announce(`${s.title}. ${s.annotation}`); }
  renderSteps();
}

function setStatus(phase: string, title: string) {
  $('#stage-status').innerHTML = `<span class="phase">${esc(phase)}</span><span>${esc(title)}</span>`;
}

function renderSteps() {
  $('#steps').innerHTML = scenes.map((s, i) => `<li><button data-step="${i + 1}" class="${i < cursor ? 'done' : ''} ${i === cursor - 1 ? 'cur' : ''}"
    title="${esc(s.title)}" aria-label="Step ${s.seq}: ${esc(s.title)}">${s.seq}<span>${esc(s.phase)}</span></button></li>`).join('');
  ($('#r-prev') as HTMLButtonElement).disabled = cursor <= 1;
  ($('#r-next') as HTMLButtonElement).disabled = cursor >= scenes.length;
  ($('#r-play') as HTMLButtonElement).disabled = !scenes.length;
}

function replay() {
  clearInterval(timer);
  show(1);
  timer = window.setInterval(advance, Math.max(STEP_MS, 900));
}

// ------------------------------------------------------------------ result panels
function renderResult() {
  if (!result) return;
  const top = result.candidates[0];
  const supported = result.evidence_status === 'supported';
  $('#incident-chip').hidden = false;
  $('#incident-chip').innerHTML = `<span class="sev sev-${esc(result.incident.severity)}">${esc(result.incident.severity)}</span>${esc(result.incident.id)} · ${esc(result.incident.name)}`;
  $('#summary').innerHTML = `
    <div class="verdict ${supported ? 'ok' : 'weak'}">
      <div class="eyebrow">${supported ? 'Leading hypothesis · evidence-supported, not verified' : 'Insufficient evidence for a confident diagnosis'}</div>
      <h1><button class="ref big" data-id="${esc(top.id)}">${esc(top.id)}</button> ${esc(top.name)}</h1>
      <p class="muted">on ${esc(top.service_name)} · ${hhmm(top.at)} UTC · score ${top.score}/100 (heuristic)</p>
      <p>${refs(result.narrative)}</p>
      <p class="next"><strong>Next step:</strong> ${refs(top.next_step)}</p>
      <div class="actions">
        <button data-blast="${esc(top.service)}">Blast radius</button>
        <button data-rollback="${esc(top.id)}">Explore rollback scenario</button>
        <button data-chain="1">Show evidence path</button>
      </div>
      <p class="muted small">Intent: ${esc(result.intent.incident_id)} via ${esc(result.intent.matched_by)} · deterministic engine, no LLM used.</p>
    </div>
    ${drill && drill.incident_id === result.incident.id ? `<div class="drill-verdict ${top.id === drill.injected_cause ? 'ok' : 'bad'}">
      ${top.id === drill.injected_cause ? '✓' : '✗'} Fire drill: the agent ranked <strong>${esc(top.id)}</strong> #1. The injected cause was
      <strong>${esc(drill.injected_cause)}</strong>${drill.decoy ? `; decoy ${esc(drill.decoy)} (closer in time) was rejected by topology` : ''}.</div>` : ''}
    <div id="actions-plan" class="actions-plan"></div>`;
  loadActions(result.investigation_id);
  $('#tab-hyp').innerHTML = result.candidates.map(renderCandidate).join('');
  renderEvidence(); renderBlast(result.blast_radius); renderTimeline();
}

const TERM_COLORS: Record<string, string> = { temporal: '#8d82cf', reachability: '#45d4e8', corroboration: '#7fe3f0', mechanism: '#f5b544', history: '#c99a5c' };
const TERM_MAX: Record<string, number> = { temporal: 20, reachability: 20, corroboration: 30, mechanism: 20, history: 10 };

function renderCandidate(c: Candidate): string {
  const bar = Object.entries(c.terms).map(([k, v]) => `<i style="width:${v}%;background:${TERM_COLORS[k]}" title="${k} ${v}/${TERM_MAX[k]}"></i>`).join('');
  const list = (title: string, items: string[], cls: string) => items.length ? `<h4 class="${cls}">${title}</h4><ul>${items.map(i => `<li>${refs(i)}</li>`).join('')}</ul>` : '';
  const tests = c.contents.flatMap(x => x.tests.map(t => `${t.id} ${t.status}`));
  return `<article class="cand ${c.rank === 1 ? 'lead' : ''}">
    <header><span class="rank">#${c.rank}</span><button class="ref" data-id="${esc(c.id)}">${esc(c.id)}</button>
      <span class="cname">${esc(c.name)}</span><span class="score">${c.score}</span></header>
    <div class="bar" role="img" aria-label="score terms: ${Object.entries(c.terms).map(([k, v]) => `${k} ${v}`).join(', ')}">${bar}</div>
    <div class="terms">${Object.entries(c.terms).map(([k, v]) => `<span><i style="background:${TERM_COLORS[k]}"></i>${k} ${v}/${TERM_MAX[k]}</span>`).join('')}</div>
    <p class="muted small">${esc(c.label)} → ${esc(c.service_name)} · ${hhmm(c.at)} UTC · ${c.explains_symptom ? 'on a sync path from the symptom' : '<span class="neg">no sync path to the symptom</span>'}
      ${c.owners ? ` · owner ${esc(c.owners.team)} (${c.owners.engineers.map(esc).join(', ')})` : ''}</p>
    <details ${c.rank === 1 ? 'open' : ''}><summary>Evidence & reasoning</summary>
      ${list('Supports', c.supporting, 'pos')}${list('Contradicts', c.contradicting, 'neg')}${list('Ruled out nearby', c.ruled_out, '')}
      ${list('Unknowns', c.unknowns, 'unk')}
      <h4>Contents</h4><ul>${c.contents.map(x => `<li><span class="mono">${esc(x.rel)}</span> <button class="ref" data-id="${esc(x.id)}">${esc(x.id)}</button> ${esc(x.name)}${x.author ? ` — ${esc(x.author)}` : ''}${x.modules.length ? ` <span class="mono muted">${x.modules.map(esc).join(', ')}</span>` : ''}</li>`).join('')}</ul>
      ${tests.length ? `<p class="muted small">Tests: ${tests.map(esc).join(' · ')}</p>` : ''}
      <p class="next"><strong>Verify:</strong> ${refs(c.next_step)}</p>
      <div class="actions"><button data-path="${esc(c.id)}">Show path</button><button data-blast="${esc(c.service)}">Blast radius</button><button data-rollback="${esc(c.id)}">Rollback scenario</button></div>
    </details></article>`;
}

function renderEvidence() {
  if (!result) return;
  $('#tab-ev').innerHTML = `<p class="muted small">Every row is a node returned by FalkorDB. Click to focus it in the graph.</p>
  <table class="ledger"><thead><tr><th>Time</th><th>Source</th><th>Detail</th><th>Stance</th></tr></thead><tbody>
  ${result.evidence.map(e => `<tr data-focus="${esc(e.id)}" tabindex="0">
    <td class="mono">${hhmm(e.at)}</td>
    <td><span class="kind k-${esc(e.kind)}">${esc(e.kind)}</span><br><span class="mono">${esc(e.id)}</span></td>
    <td>${esc(e.detail)}<br><span class="mono muted small">${esc(e.relation)}</span><br><span class="muted small">${esc(e.source ?? '')}</span></td>
    <td><span class="stance s-${esc(e.stance)}">${esc(e.stance)}</span></td></tr>`).join('')}
  </tbody></table>`;
}

function renderBlast(br: BlastRadius) {
  $('#tab-blast').innerHTML = `<p>Services that depend on <button class="ref" data-id="${esc(br.origin)}">${esc(br.origin)}</button> within 4 hops:
    <strong>${br.services.length}</strong> (${br.services.filter(s => s.impact === 'direct').length} direct).</p>
    <p class="muted small">Computed by <span class="mono">MATCH p=(u:Service)-[:DEPENDS_ON*1..4]->(t)</span>. Reachability means exposure, not a confirmed outage.</p>
    <ul class="blast">${br.services.map(s => `<li><button class="ref" data-id="${esc(s.id)}">${esc(s.name)}</button>
      <span class="impact i-${esc(s.impact.split(' ')[0])}">${esc(s.impact)}</span> <span class="muted small">${s.hops} hop(s) · ${s.path.map(esc).join(' → ')}${s.betweenness ? ` · chokepoint score ${s.betweenness}` : ''}</span></li>`).join('')}</ul>`;
}

function renderTrace() {
  $('#tab-trace').innerHTML = trace.length ? `<p class="muted small">${trace.length} read-only queries (GRAPH.RO_QUERY). Parameters are bound, never interpolated.</p>` +
    trace.map(t => `<details class="q"><summary><span class="mono">${t.step}. ${esc(t.query)}</span><span class="muted small">${t.rows} rows · ${t.ms} ms</span></summary>
      <pre>${esc(t.cypher)}</pre><pre class="params">${esc(JSON.stringify(t.params))}</pre></details>`).join('')
    : '<p class="muted">No queries yet.</p>';
}

function renderTimeline() {
  if (!result) return;
  const items = result.evidence;
  const t0 = Math.min(...items.map(i => i.ts)), t1 = Math.max(...items.map(i => i.ts), result.incident.ts);
  const span = Math.max(t1 - t0, 1);
  const x = (ts: number) => `${2 + ((ts - t0) / span) * 96}%`;
  $('#timeline').innerHTML = `<div class="axis">
    <span class="onset" style="left:${x(result.incident.ts)}" title="Incident start">incident start ${hhmm(result.incident.at)}</span>
    ${items.map((e, i) => `<button class="tick k-${esc(e.kind)} s-${esc(e.stance)}" style="left:${x(e.ts)};top:${8 + (i % 4) * 14}px" data-focus="${esc(e.id)}"
       title="${esc(`${hhmm(e.at)} ${e.id} ${e.detail}`)}" aria-label="${esc(`${hhmm(e.at)} ${e.kind} ${e.id}`)}"></button>`).join('')}
    <span class="lbl" style="left:0">${new Date(t0 * 1000).toISOString().slice(11, 16)} UTC</span>
    <span class="lbl" style="right:0">${new Date(t1 * 1000).toISOString().slice(11, 16)} UTC</span></div>`;
}

// ------------------------------------------------------------------ focus, blast, rollback
function edgesOf(id: string): [string, string][] {
  const out: [string, string][] = [];
  for (const s of scenes.slice(0, cursor)) for (const [a, b] of s.edges) if (a === id || b === id) out.push([a, b]);
  for (const d of base?.dependencies ?? []) if (d.src === id || d.dst === id) out.push([d.src, d.dst]);
  return out;
}

async function focusEntity(id: string) {
  scene?.select(id);
  scene?.apply(scenes.slice(0, cursor), { path: edgesOf(id), focus: [id], particles: 'trace' });
  const box = $('#entity');
  box.hidden = false;
  box.innerHTML = `<p class="muted">Loading ${esc(id)}…</p>`;
  try {
    const e = await api<{ node: Record<string, unknown>; labels: string[]; neighbors: { type: string; out: boolean; id: string; name: string; label: string }[] }>(`/api/entity/${encodeURIComponent(id)}`);
    const props = Object.entries(e.node).filter(([k]) => !['id', 'name', 'source', 'record'].includes(k));
    box.innerHTML = `<button class="close" aria-label="Close">×</button>
      <div class="eyebrow">${e.labels.map(esc).join(' · ')}</div><h3>${esc(e.node.id)} <span>${esc(e.node.name)}</span></h3>
      <dl>${props.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(Array.isArray(v) ? v.join(' · ') : v)}</dd>`).join('')}</dl>
      <p class="muted small">source: ${esc(e.node.source)}</p>
      <h4>Relationships (${e.neighbors.length})</h4>
      <ul>${e.neighbors.map(n => `<li class="mono small">${n.out ? `-[:${esc(n.type)}]->` : `<-[:${esc(n.type)}]-`} <button class="ref" data-id="${esc(n.id)}">${esc(n.id)}</button> <span class="muted">${esc(n.label)}</span></li>`).join('')}</ul>
      ${e.labels.includes('Service') ? `<div class="actions"><button data-blast="${esc(id)}">Blast radius</button></div>` : ''}
      ${e.labels.includes('Change') ? `<div class="actions"><button data-rollback="${esc(id)}">Rollback scenario</button></div>` : ''}`;
  } catch (err) {
    box.innerHTML = `<button class="close" aria-label="Close">×</button><p class="error">${esc((err as Error).message)}</p>`;
  }
}

function closeEntity() {
  $('#entity').hidden = true;
  scene?.select(null);
  scene?.apply(scenes.slice(0, cursor));
}

async function showBlast(sid: string) {
  try {
    const br = await api<BlastRadius>(`/api/blast-radius/${encodeURIComponent(sid)}`);
    renderBlast(br); tab('blast');
    scene?.apply(scenes.slice(0, cursor), { path: br.edges, focus: [sid, ...br.services.map(s => s.id)], particles: 'blast' });
    setStatus('Blast radius', `${br.services.length} services depend on ${sid}`);
    announce(`${br.services.length} services depend on ${sid}.`);
  } catch (e) { setStatus('Error', (e as Error).message); }
}

function showPath(cid: string) {
  const c = result?.candidates.find(x => x.id === cid);
  if (!c) return;
  const p = c.reach ? [...c.reach.path, c.id] : [c.service, c.id];
  const path = p.slice(1).map((b, i) => [p[i], b] as [string, string]);
  scene?.apply(scenes.slice(0, cursor), { path, focus: [cid], particles: c.explains_symptom ? 'converge' : 'trace' });
  setStatus('Path', c.reach ? p.join(' → ') : `${cid}: no dependency path from the symptom`);
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
  setStatus('Evidence path', 'Alert → symptom → dependency → change → config → mechanism ← signals (one Cypher query)');
}

async function showRollback(cid: string) {
  const dlg = $('#rollback') as HTMLDialogElement;
  $('#rb-body').innerHTML = '<p class="muted">Loading…</p>';
  dlg.showModal();
  try {
    const p = await api<any>(`/api/rollback-preview/${encodeURIComponent(cid)}`);
    $('#rb-body').innerHTML = `<div class="banner">Scenario preview only — nothing has been executed. executed=${p.executed}</div>
      <h2 id="rb-title">Roll back ${esc(cid)} · ${esc(p.change.name)}</h2>
      <h4>Would revert</h4><ul>${p.reverts.map((r: any) => `<li><span class="mono">${esc(r.id)}</span> ${esc(r.name)}${r.restores ? ` → restores <span class="mono">${esc(r.restores)}</span>` : ' <span class="unk">(code change — collateral)</span>'}</li>`).join('')}</ul>
      <h4>Restart exposure (services depending on ${esc(p.service)})</h4><ul>${p.restart_affects.map((s: any) => `<li>${esc(s.name)} <span class="muted">${esc(s.impact)}</span></li>`).join('')}</ul>
      <h4>Signals to re-check afterwards</h4><p class="mono">${p.signals_to_recheck.map(esc).join(', ') || 'none recorded'}</p>
      <h4>Validation</h4><ul>${p.validation.map((v: string) => `<li>${refs(v)}</li>`).join('') || '<li>No tests recorded.</li>'}</ul>
      <h4>Unknowns</h4><ul>${p.unknowns.map((u: string) => `<li>${esc(u)}</li>`).join('')}</ul>`;
  } catch (e) {
    $('#rb-body').innerHTML = `<p class="error">${esc((e as Error).message)}</p>`;
  }
}

async function loadInvestigation(id: string) {
  try {
    const r = await api<Result>(`/api/investigations/${encodeURIComponent(id)}`);
    clearInterval(timer); timer = 0;
    result = r; scenes = r.scenes; trace = r.trace;
    renderResult(); renderTrace();
    $('#summary').insertAdjacentHTML('afterbegin', `<div class="banner">Historical record ${esc(id)} — a past hypothesis, re-check against current graph state.</div>`);
    replay();
  } catch (e) { setStatus('Error', (e as Error).message); }
}

function tab(name: string) {
  document.querySelectorAll<HTMLButtonElement>('.tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  ['hyp', 'ev', 'blast', 'trace'].forEach(t => ($(`#tab-${t}`).hidden = t !== name));
}

function setMode(p: boolean) {
  document.body.classList.toggle('pixel', p);
  $('#mode-workspace').setAttribute('aria-selected', String(!p));
  $('#mode-pixel').setAttribute('aria-selected', String(p));
  scene?.setPixelStream(p, scenes.slice(0, cursor));
  if (p && scenes.length) replay();
}

// ------------------------------------------------------------------ events
$('#ask').addEventListener('submit', e => { e.preventDefault(); investigate(($('#q') as HTMLTextAreaElement).value); });
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#ask').dispatchEvent(new Event('submit')); });
$('#r-prev').addEventListener('click', () => { clearInterval(timer); timer = 0; show(cursor - 1); });
$('#r-next').addEventListener('click', () => { clearInterval(timer); timer = 0; show(cursor + 1); });
$('#r-play').addEventListener('click', replay);
$('#mode-workspace').addEventListener('click', () => setMode(false));
$('#mode-pixel').addEventListener('click', () => setMode(true));
document.addEventListener('keydown', e => {
  if ((e.target as HTMLElement).closest('textarea, input')) return;
  if (e.key === 'ArrowLeft' && cursor > 1) show(cursor - 1);
  if (e.key === 'ArrowRight' && cursor < scenes.length) show(cursor + 1);
  if (e.key === 'Escape') closeEntity();
});
document.addEventListener('click', e => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('button, tr[data-focus]');
  if (!t) return;
  const d = t.dataset;
  if (d.approve) approve(d.approve, d.vid!);
  else if (d.lift) api('/api/actions/lift-freezes', { method: 'POST' }).then(() => { refreshBase(); if (result) loadActions(result.investigation_id); });
  else if (t.id === 'drill-go') runDrill();
  else if (t.id === 'drill-reset') resetDrills();
  else if (d.id || d.focus) focusEntity((d.id ?? d.focus)!);
  else if (d.q) { ($('#q') as HTMLTextAreaElement).value = d.q; investigate(d.q); }
  else if (d.inc) { const q = `Investigate ${d.inc}`; ($('#q') as HTMLTextAreaElement).value = q; investigate(q); }
  else if (d.inv) loadInvestigation(d.inv);
  else if (d.blast) showBlast(d.blast);
  else if (d.rollback) showRollback(d.rollback);
  else if (d.path) showPath(d.path);
  else if (d.chain) showChain();
  else if (d.step) { clearInterval(timer); timer = 0; show(Number(d.step)); }
  else if (d.tab) tab(d.tab);
  else if (t.classList.contains('close')) closeEntity();
});
document.addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (e.key === 'Enter' && t.matches('tr[data-focus]')) focusEntity(t.dataset.focus!);
});
window.addEventListener('pagehide', () => scene?.dispose());

boot();
