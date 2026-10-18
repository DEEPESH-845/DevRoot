# DevRoot

**Root cause, proven by the graph.**

DevRoot investigates a production incident by walking a FalkorDB graph from the alert, through the service dependencies,
to the change that explains it. It ranks the candidate causes with a transparent score, computes the blast radius,
and previews a rollback. Every claim cites the graph ids and the exact path FalkorDB returned. The Three.js scene you
watch is the investigation's own state stream, and you can replay it step by step.

- **Track:** 01 · Agents That Act on Connected Data
- **Data:** fully synthetic (fictional company *Northstar Labs*). No real incidents, telemetry or people.
- **AI assistance disclosure:** this project was built with an AI coding assistant (Claude Code), as the rules allow.

## Quick start (local, no Docker needed)

Requirements: Python 3.12 (`uv` recommended), Node 18+.

```bash
./run.sh            # creates .venv, installs deps, builds the UI, starts http://127.0.0.1:8000
```

FalkorDB runs **embedded** by default (`falkordblite` starts a real FalkorDB server process, persisted in `data/devroot.db`).
To use a standalone FalkorDB instead:

```bash
docker run -p 6379:6379 -it --rm falkordb/falkordb:latest
FALKORDB_URL=redis://localhost:6379 ./run.sh
```

| Env var | Default | Meaning |
|---|---|---|
| `FALKORDB_URL` | unset → embedded | FalkorDB server URL (Docker / FalkorDB Cloud) |
| `DEVROOT_DB_PATH` | `data/devroot.db` | Embedded database file |
| `DEVROOT_GRAPH` | `devroot` | Graph name |
| `HOST` / `PORT` | `127.0.0.1` / `8000` | Bind address |

The seed loads at startup and is **idempotent**: every node is `MERGE`d on a stable `id`, and a unique constraint exists on `id` per label.
To reset, stop the server and delete `data/`.

Dev mode with hot reload: run `cd backend && ../.venv/bin/uvicorn devroot.app:app --reload` and `cd frontend && npm run dev` (Vite proxies `/api`).

## Two-minute demo

1. Open http://127.0.0.1:8000. You see the Northstar Labs service graph. Particles flow along `DEPENDS_ON` edges; dashed edges are async (queued); the alerting services (checkout, gateway) jitter.
2. Click **Run investigation** (the default request asks about the payment latency spike).
3. Watch 9 steps stream in. Each step is a read-only Cypher query; its text, parameters, row count and timing are in **Cypher trace**.
4. The verdict: **DEP-884 payment-service v4.12.0** (score 95.2, heuristic). It ships `CFG-311 ledger.client.pool.max_size 50 → 8`.
   The page fired on *checkout*, but the cause is one synchronous hop downstream.
5. **Hypotheses** shows why the alternatives lose:
   - `CFG-319` is the closest change in time, and its mechanism even matches a signal, but it has *no dependency path* to the symptom.
   - `DEP-881` sits on the alerting service, but no signal matches anything it changed.
   - `DEP-886` shipped *after* the incident began.
6. **Show evidence path** lights up the one-query proof: alert → checkout → payment → DEP-884 → CFG-311 → *pool exhaustion* ← 3 signals.
7. **Blast radius**: 4 dependents (checkout and refund directly; gateway and storefront transitively).
8. **Replay** (or ◀ ▶ / arrow keys) steps through the investigation forwards and backwards.
9. **PixelStream** turns the canvas into the entire surface: the agent's state stream drives the scene and an in-canvas status card.
10. **Explore rollback scenario** previews what would be reverted, the restart exposure, the signals to re-check and the unknowns. *Nothing is executed.*

11. **Agent actions:** under the verdict, DevRoot proposes three actions whose targets come from graph queries:
    - page the owners and the change author
    - freeze deploys on the cause service and its synchronous dependents
    - open a rollback change request

    **Approve & record** writes an `(:Action)-[:TARGETS]->(...)` into FalkorDB. Frozen services immediately render ice-blue with a `· frozen` label.
12. **Fire drill** (left panel): pick any service and mechanism, then click **Inject & investigate**.
    DevRoot writes a fresh synthetic incident: a graph query picks the nearest synchronous caller as the place the symptom surfaces,
    and a decoy change closer in time lands on a service the symptom can't reach. The agent investigates without the answer key,
    and the verdict banner compares its #1 with the injected cause. **Reset drills** deletes everything the drill created.

The demo needs no network access and no API keys.

## Architecture

```
frontend (Vite + TypeScript + three.js)          backend (FastAPI, Python 3.12)                  FalkorDB
  command bar ── GET /api/investigate (SSE) ──▶ agent.Investigation.run(): fixed bounded plan ──▶ GRAPH.RO_QUERY ×12
  GraphScene ◀── event: step {scene, trace} ───   one SceneState per step (pydantic-validated)
  panels ◀────── event: result ───────────────   score_candidate() pure function
  replay/memory ◀ GET /api/investigations/{id}   CREATE (:Investigation)-[:HYPOTHESIZED]->(:Change)
  blast/rollback ◀ GET /api/blast-radius, /api/rollback-preview
```

- `backend/devroot/seed.py` holds the synthetic dataset and the idempotent loader.
- `backend/devroot/agent.py` holds every Cypher query (`Q`), the investigation plan, scoring, blast radius and rollback preview.
- `backend/devroot/app.py` serves the HTTP API and the built UI.
- `backend/devroot/mcp_server.py` exposes the same capabilities as MCP tools (stdio).
- `frontend/src/scene.ts` is the WebGL renderer; `frontend/src/main.ts` holds UI state, the SSE client and the panels.

**The FalkorDB removal test.** Every investigative endpoint reads the graph. If FalkorDB is unreachable, the API returns
`503 graph_unavailable` and the UI shows "Graph reasoning unavailable". There is no canned fallback answer. This is covered by `test_graph_down_returns_503`.

**Safety.** All investigation queries use `ro_query` (FalkorDB rejects writes) with bound parameters. Ids are validated (`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`).
Every variable-length traversal is capped at 4 hops, and every query has a 5 s timeout. The only write is the `:Investigation` record.

## Agent tools, actions and drills (Track 01)

| Capability | How the graph does the work |
|---|---|
| **Graph algorithms as tools** | `CALL algo.betweenness({nodeLabels:['Service'], relationshipTypes:['DEPENDS_ON'], samplingSize:2000, samplingSeed:42})` and `algo.pageRank('Service','DEPENDS_ON')`. Betweenness is FalkorDB's *sampled* estimate; the seed is fixed so results reproduce. It sizes service nodes, names the biggest chokepoint in the blast step, and is query #11 of every investigation. |
| **Actions based on what the graph shows** | `GET /api/actions/plan/{investigation}` derives targets: owners via `OWNED_BY`/`MEMBER_OF`, authors via `AUTHORED_BY\|CHANGED_BY`, freeze set = blast radius over sync `DEPENDS_ON*1..4`. `POST /api/actions` (the operator's approval) re-derives the targets and MERGEs `(:Action {status:'recorded', approved_by:'operator'})-[:TARGETS]->(...)`. Freeze and rollback actions are only offered when the evidence status is *supported*. **No external pager or CI system is called.** |
| **Tool selection through MCP** | `python -m devroot.mcp_server` (stdio) exposes `list_incidents`, `investigate`, `blast_radius`, `service_criticality`, `rollback_preview`, `get_entity`, `plan_actions`, `record_action`. The tools call the DevRoot API, so there is one graph and one set of validations. |
| **Fire drill** | `POST /api/drills {service_id, mechanism}` writes a new deployment, config change, signals, alert and incident. The symptom service is chosen by `MATCH p=(u)-[:DEPENDS_ON*1..2]->(s) WHERE all(... sync)`, and the decoy goes on a service with `NOT (u)-[:DEPENDS_ON*1..4]->(d)`. Tests inject every service × mechanism (12 drills) and assert that the agent ranks the injected change #1. |

Use DevRoot from Claude Code (with `./run.sh` running):

```bash
claude mcp add devroot -e PYTHONPATH=$PWD/backend -- $PWD/.venv/bin/python -m devroot.mcp_server
# then ask: "Use devroot to investigate INC-2041 and propose actions"
```

## Graph model

| Label | Key properties | Notes |
|---|---|---|
| `Service` | id, name, kind (service · database · queue · external), env | 11 components |
| `Team`, `Engineer` | id, name, handle | ownership and authorship |
| `Change` + `Deployment` | id, name, version, ts, at, env, status | a unit of change applied to prod |
| `Change` + `ConfigChange` | id, key, old_value, new_value, ts | standalone runtime config change |
| `ConfigChange` (no `Change`) | same | config shipped *inside* a deployment |
| `Commit`, `CodeModule`, `Test` | sha / path / status | code lineage and verification |
| `Signal` + `MetricSignal` / `LogEvent` | name, baseline, observed, unit / level, message, ts | observations |
| `Alert`, `Incident` | severity, ts, status (open / resolved), resolution | |
| `FailureMode` | name, description | the *mechanism* that links changes to signals |
| `Runbook` | name, steps[] | |
| `Investigation` | query, status='hypothesis', top_candidate, record (JSON) | DevRoot's own memory; never treated as fact |
| `Action` | type, status (recorded / lifted), actor, approved_by, detail | an approved agent action |

Relationships:

- `(Service)-[:DEPENDS_ON {mode: sync|async, protocol}]->(Service)`
- `(Service)-[:OWNED_BY]->(Team)`, `(Engineer)-[:MEMBER_OF]->(Team)`
- `(Deployment)-[:DEPLOYED_TO]->(Service)`, `(ConfigChange)-[:APPLIED_TO]->(Service)`
- `(Deployment)-[:INCLUDES]->(Commit)-[:MODIFIES]->(CodeModule)-[:PART_OF]->(Service)`
- `(Deployment)-[:SHIPS]->(ConfigChange)`, `(Commit)-[:AUTHORED_BY]->(Engineer)`, `(ConfigChange)-[:CHANGED_BY]->(Engineer)`
- `(Test)-[:COVERS]->(CodeModule)`
- `(ConfigChange|Commit)-[:TOUCHES]->(FailureMode)<-[:INDICATES]-(Signal)`, `(Signal)-[:OBSERVED_IN]->(Service)`
- `(Incident)-[:TRIGGERED_BY]->(Alert)-[:FIRED_ON]->(Service)`
- `(Incident {status:'resolved'})-[:EXHIBITED]->(FailureMode)`, `(Incident)-[:RESOLVED_BY]->(Runbook)-[:MITIGATES]->(FailureMode)`
- `(Investigation)-[:INVESTIGATED]->(Incident)`, `(Investigation)-[:HYPOTHESIZED {rank, score}]->(Change)`
- `(Action)-[:FOR_INVESTIGATION]->(Investigation)`, `(Action)-[:TARGETS]->(Service|Engineer|Change)`

Example records:

```
(:Change:Deployment {id:'DEP-884', name:'payment-service v4.12.0', at:'2026-10-14T13:52Z', env:'prod', source:'synthetic/northstar-seed-v1'})
  -[:SHIPS]->(:ConfigChange {id:'CFG-311', key:'ledger.client.pool.max_size', old_value:'50', new_value:'8'})
  -[:TOUCHES]->(:FailureMode {id:'fm-pool-exhaustion', name:'connection-pool exhaustion'})
  <-[:INDICATES]-(:Signal:LogEvent {id:'LOG-7710', level:'ERROR', message:'LedgerClient: timed out after 2000ms acquiring connection (pool max_size=8, waiting=143)'})
```

## Investigation plan and Cypher

Each step is one query; there are 13 per investigation (see the *Cypher trace* tab for live timings).

1. Resolve the intent to an incident: an explicit `INC-nnnn` id, otherwise keyword overlap with the open incidents in the graph. No match → "nothing to investigate".
2. Load the incident context: incident → alerts → symptom services.
3. Walk the dependency frontier from the symptoms (≤4 hops; sync paths preferred).
4. Find candidate changes from 6 h before to 1 h after the incident start.
5. Gather contents, touched mechanisms, and the signals observed on the changed service and its direct dependencies after the change.
6. Look up incident history and runbooks for the mechanisms found.
7. Rank the candidates.
8. Run the evidence-chain proof query for the top candidate.
9. Compute the blast radius and ownership, then persist the investigation as a hypothesis.

**`incident_context`**
```cypher
MATCH (i:Incident {id: $iid})-[:TRIGGERED_BY]->(a:Alert)-[:FIRED_ON]->(s:Service)
RETURN properties(i) AS incident, properties(a) AS alert, properties(s) AS service
```

**`dependency_frontier`**
```cypher
MATCH p = (s:Service)-[:DEPENDS_ON*0..4]->(d:Service)
WHERE s.id IN $symptoms
RETURN s.id AS origin, d.id AS target, length(p) AS hops, [n IN nodes(p) | n.id] AS path,
       all(r IN relationships(p) WHERE r.mode = 'sync') AS sync
ORDER BY hops LIMIT 500
```

**`candidate_changes`**
```cypher
MATCH (c:Change)-[:DEPLOYED_TO|APPLIED_TO]->(s:Service)
WHERE c.ts >= $from AND c.ts <= $to AND c.env = $env
RETURN properties(c) AS change, labels(c) AS labels, s.id AS service, s.name AS service_name
ORDER BY c.ts LIMIT 50
```

**`touched_mechanisms`**
```cypher
UNWIND $cids AS cid
MATCH (c:Change {id: cid})-[:SHIPS|INCLUDES*0..1]->(x)-[:TOUCHES]->(fm:FailureMode)
RETURN cid, x.id AS via, x.name AS via_name, labels(x)[0] AS via_label, fm.id AS fm, fm.name AS fm_name
```

**`scoped_signals`**
```cypher
UNWIND $cids AS cid
MATCH (c:Change {id: cid})-[:DEPLOYED_TO|APPLIED_TO]->(cs:Service)-[:DEPENDS_ON*0..1]->(scope:Service)
MATCH (sig:Signal)-[:OBSERVED_IN]->(scope)
WHERE sig.ts >= c.ts AND sig.ts <= $until
OPTIONAL MATCH (sig)-[:INDICATES]->(fm:FailureMode)
RETURN DISTINCT cid, properties(sig) AS signal, labels(sig) AS labels, scope.id AS service, fm.id AS fm
```

**`mechanism_history`**
```cypher
MATCH (fm:FailureMode) WHERE fm.id IN $fms
OPTIONAL MATCH (rb:Runbook)-[:MITIGATES]->(fm)
OPTIONAL MATCH (p:Incident {status: 'resolved'})-[:EXHIBITED]->(fm)
RETURN fm.id AS fm, fm.name AS name, collect(DISTINCT properties(rb)) AS runbooks,
       collect(DISTINCT properties(p)) AS incidents
```

**`evidence_chain`**
```cypher
MATCH (i:Incident {id: $iid})-[:TRIGGERED_BY]->(a:Alert)-[:FIRED_ON]->(s:Service)
MATCH p = (s)-[:DEPENDS_ON*0..4]->(cs:Service)<-[:DEPLOYED_TO|APPLIED_TO]-(c:Change {id: $cid})
WHERE all(r IN relationships(p) WHERE type(r) <> 'DEPENDS_ON' OR r.mode = 'sync')
MATCH (c)-[:SHIPS|INCLUDES*0..1]->(x)-[:TOUCHES]->(fm:FailureMode)<-[:INDICATES]-(sig:Signal)
WHERE sig.ts >= c.ts
RETURN a.id AS alert, [n IN nodes(p) | n.id] AS path, length(p) AS hops, x.id AS element, fm.id AS fm,
       collect(DISTINCT sig.id) AS signals
ORDER BY hops LIMIT 10
```

**`blast_radius`**
```cypher
MATCH p = (u:Service)-[:DEPENDS_ON*1..4]->(t:Service {id: $sid})
RETURN u.id AS service, u.name AS name, u.kind AS kind, length(p) AS hops, [n IN nodes(p) | n.id] AS path,
       all(r IN relationships(p) WHERE r.mode = 'sync') AS sync
ORDER BY hops LIMIT 200
```

## Ranking (heuristic, max 100, *not a probability*)

| Term | Max | Definition |
|---|---|---|
| temporal | 20 | `20 × (1 − Δt / 6h)` if the change precedes the incident start, else 0 |
| reachability | 20 | sync path from a symptom service: `20 − 4·hops`; async-only: 4; none: 0 |
| corroboration | 30 | among signals that INDICATE a mechanism the change TOUCHES: 10 per distinct signal kind (≤20), +10 if they come from ≥2 services |
| mechanism | 20 | 20 if a matched mechanism is documented by a runbook, 10 if it is matched but undocumented |
| history | 10 | a resolved incident EXHIBITED a matched mechanism |

If a change has **no** dependency path to any symptom service, corroboration, mechanism and history are multiplied by **0.25**.
That evidence shows the change is causing *a* problem, but it cannot explain *this* one, so it must not outvote reachability
(e.g. DEP-884 for the notification incident INC-2042).

"Supported" requires a score ≥ 60, a sync path to the symptom, and at least one matched signal. Otherwise the result says *insufficient evidence*.
The weights are hand-chosen and **not calibrated** on real incidents; no accuracy figures are claimed.
Each candidate returns its supporting evidence, contradicting evidence, components ruled out nearby, unknowns, and the next verification step.

## What is deterministic, what is GPU-rendered, and what is an LLM

- **LLM: none.** No provider is configured. Intent parsing, ranking and narrative are deterministic code over query rows (`llm_used: false` in every result).
  The same input on the same graph gives the same ranking (`test_ranking_is_deterministic`).
- **GPU particles:** `GPUComputationRenderer` stores particle positions in float render targets, and a fragment shader advances them every frame
  (follow the assigned edge, ease toward its target, jitter near alerting services). The CPU uploads only edge endpoints and emphasis
  (≤256 edges, as a DataTexture) when the investigation state changes. There are 9,216 particles, or 2,304 on mobile or ≤4-core devices.
  Particles are turned off when `prefers-reduced-motion` is set or float render targets are unavailable (the reason is shown in the FalkorDB status tooltip).
- **Nodes, edges and labels** are a single `Points` (custom shader), a single `LineSegments`, and `CanvasTexture` sprites. Picking is screen-space and maps back to graph ids.
  Bloom uses `UnrealBloomPass` at low strength. Without WebGL the canvas shows a notice, and the investigation, evidence and replay keep working.
- **Particle semantics:** cyan = the edge being traversed in this step; amber = evidence converging on the hypothesis; coral = blast-radius propagation (from the cause to its dependents);
  slate = idle dependency flow. Particles move along the *traversal* direction, which can run against the stored edge direction (e.g. signal → mechanism ← config ← deployment). They never move along edges that don't exist.

## PixelStream mode: what it is and what it is not

The inspiration is Flipbook, a 2026 prototype that streams model-generated video frames as the whole interface.
As of 2026-10-18 it has **no public SDK or API** (secondary coverage describes a hosted video model on GPU infrastructure), so DevRoot does **not** integrate model-generated pixels.

DevRoot's PixelStream mode is **agent-directed local rendering**. The investigation engine emits typed `SceneState` objects
(phase, revealed entities and edges, traversal path, focus, particle mode, hypothesis, evidence status). The WebGL renderer turns only those into pixels,
and that includes the status card, which is drawn inside the canvas. Every replay re-applies the recorded scene states (stored on the `:Investigation` node).
An `aria-live` region mirrors each annotation for screen readers. The in-canvas footer says this: *"agent-directed local WebGL · no model-generated frames"*.
No frame-provider adapter is built, because there is no provider to adapt to.

## Tests

```bash
cd backend && ../.venv/bin/python -m pytest -q          # 38 tests (incl. 12 fire drills), embedded FalkorDB in a temp dir
cd frontend && npm run build                             # tsc --noEmit + vite build
```

The tests cover:
- seed idempotency and the unique constraint
- the graph-found root cause, deterministic ranking, and contradiction of unreachable and late changes
- evidence-chain ids that exist in FalkorDB, and blast-radius semantics
- insufficient evidence and unmatched requests (no guessing), and invalid ids and over-long queries (422)
- the SSE stream, SceneState validation, the investigation write-back, rollback being preview-only, and graph-down → 503
- reproducible graph-algorithm output, actions derived from the graph (and withheld when evidence is insufficient), idempotent action records, and every fire drill rediscovered
- MCP tools listed and `investigate` called in-process

## Limitations

- One seeded scenario. Real telemetry would need ingestion adapters (none are implemented).
- The score weights are heuristics. Signal-to-mechanism (`INDICATES`) and change-to-mechanism (`TOUCHES`) links are seeded by hand; in production they would come from a classifier or rules.
- The candidate scope is the changed service plus its direct dependencies; longer causal chains need a wider scope.
- No live deployment yet.
