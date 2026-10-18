# DevRoot — Build Plan

## Scope
One complete investigation of a seeded Northstar Labs incident (INC-2041), plus blast radius, replay, rollback preview,
and a scene-state-driven "PixelStream" mode. Everything else is out.

## Architecture / data flow
```
browser (Vite + TS + three)                 backend (FastAPI, Python 3.12)              FalkorDB
 command bar ──GET /api/investigate (SSE)──▶ agent.investigate(): fixed bounded plan ──▶ Cypher (parameterized, *1..4 caps)
 scene ◀── event: step {trace, scene} ──────  each step = 1 query + scene-state delta
 ledger/hypotheses ◀── event: result ───────  scoring.py (pure, deterministic)
 replay ◀── GET /api/investigations/{id} ──  write-back (:Investigation) node (hypothesis, not fact)
 blast / rollback ◀── GET /api/blast-radius, /api/rollback-preview
```
- DB: `falkordb` client. `FALKORDB_URL` → real server (Docker/Cloud); unset → embedded `falkordblite` file in `data/`.
- Graph down → every investigative endpoint returns 503 `graph_unavailable`; UI shows it. No canned answers.

## Graph schema (summary — full in README)
Labels: Service(kind: service|database|queue|external), Team, Engineer, Deployment, ConfigChange, Commit, CodeModule,
Alert, Incident, MetricSignal, LogEvent, FailureMode, Runbook, Test, Investigation.
Rels: DEPENDS_ON{mode: sync|async}, OWNED_BY, MEMBER_OF, DEPLOYED_TO, INCLUDES, SHIPS, APPLIED_TO, AUTHORED_BY, CHANGED_BY,
MODIFIES, PART_OF, FIRED_ON, TRIGGERED_BY, OBSERVED_IN, INDICATES, TOUCHES, EXHIBITED, RESOLVED_BY, MITIGATES, COVERS,
DOCUMENTS, INVESTIGATED, HYPOTHESIZED.

## Investigation sequence (agent plan, each step one query)
1. resolve intent → incident id (explicit id, else keyword match against open incidents in graph)
2. incident context: incident → alerts → symptom services
3. dependency frontier: symptom →`DEPENDS_ON{sync}*0..4`→ suspects (paths kept)
4. candidate changes: Deployments / standalone ConfigChanges in [start−6h, start] on *any* service, with reachability from step 3
5. evidence: signals after change on suspect path services, with INDICATES→FailureMode, and change TOUCHES→FailureMode
6. history: resolved incidents EXHIBITED same FailureMode → runbooks
7. score (pure function) → top candidate
8. blast radius: `(u)-[:DEPENDS_ON*1..4]->(cause service)` upstream dependents, direct/transitive, sync/async
9. ownership + tests + runbook for top candidate; write back :Investigation

## Scoring (heuristic, max 100, not a probability)
temporal ≤20 · reachability ≤20 · corroborating signal kinds ≤30 · mechanism match 20 · history 10. Documented in README.

## UI state model
`idle → investigating(step n) → complete | error(graph_unavailable|no_incident)`; `mode: workspace | pixelstream`;
`replay: {cursor}`; `focus: entityId`.

## Three.js scene
Single `GraphScene` class: Points (ShaderMaterial, per-node color/size/state attrs) for nodes, LineSegments (per-vertex state) for edges,
GPUComputationRenderer particle sim (position+velocity textures, edges in a DataTexture) for flow. Screen-space picking → entity id.
Fallbacks: no WebGL → panel-only UI; no float RT → particles off; reduced-motion → particles off, no camera tweens.
`dispose()` frees geometries/materials/RTs; animation pauses on `visibilitychange`.

## PixelStream mode
Same renderer, but the only input is the stream of `SceneState` objects (phase, focus, highlighted nodes/edges, particle mode,
annotation). Annotations are drawn *in-canvas* (CanvasTexture sprites); an aria-live region mirrors them. Replay re-feeds recorded states.
Labelled "agent-directed local WebGL rendering — no model-generated frames". No frame-provider adapter is built (no provider exists).

## Tests
`backend/tests/test_investigation.py` (pytest, embedded FalkorDB in a temp dir): seed idempotency, evidence from graph, deterministic
ranking, path retrieval, blast radius, ids in result, unknown incident → no certainty, malformed input → 4xx, scene states valid,
graph down → 503. Frontend: `tsc --noEmit` + `vite build`; scene-state validator unit-checked in pytest (shared schema).

## Acceptance
`./run.sh` → open :8000 → click Investigate → payment config change ranked #1 with path alert→checkout→payment→CFG, blast radius
lists gateway+checkout, replay steps forward/back, PixelStream replays, rollback preview opens. All tests pass.

## Risks / fallbacks
Time → cut LLM narrator, then before/after toggle, then in-canvas annotations. GPGPU breaks → particle-off path. Deploy → local only + video.
