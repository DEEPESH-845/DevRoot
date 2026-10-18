# DevRoot — Final Review (skeptical judge pass, 2026-10-18)

## Judge questions
| Question | Answer |
|---|---|
| Does FalkorDB materially determine the diagnosis? | Yes. The cause (payment-service) is not in the alerts; it is found only by the `DEPENDS_ON*0..4` frontier walk plus the TOUCHES/INDICATES join. Graph down → 503, no answer (tested). |
| Can the agent show the exact path? | Yes. The `evidence_chain` query returns alert → services → change → config → mechanism ← signals as ids; "Show evidence path" renders exactly those rows. |
| Does every displayed entity correspond to data? | Yes. The renderer adds nodes only from `/api/graph` or SceneState entities, and draws path edges only if the edge exists (`hasEdge`). A test checks that every evidence-chain id exists in FalkorDB. |
| Can the ranking be explained? | Five documented terms, a pure function (`score_candidate`), labelled heuristic and not a probability. |
| Are uncertainties explicit? | Per candidate: contradicting evidence, ruled-out components, unknowns (skipped load test, inseparable CFG-311/312, no traffic data). |
| Is the visual system interactive and meaningful? | Picking maps to graph ids; particle colour = step semantics (trace / converge / blast); replay steps backwards because the scene state is a pure function of the prefix. |
| Is PixelStream described honestly? | Yes: "agent-directed local WebGL · no model-generated frames", rendered in the canvas itself and stated in the README. |
| Better than a chat UI? | It returns ranked, contradicted, path-backed hypotheses plus the 12 queries that produced them, rather than prose. |
| Runnable from the README? | `./run.sh` was verified from a fresh DB path on a second port. |
| What fails first live? | Google Fonts offline (falls back to system fonts). Low-end GPU → particles off (shown in the tooltip). Nothing in the core flow needs the network. |

## Wow-factor sprint (see DEVROOT_WOW_PLAN.md)
Built: graph-algorithm criticality (A), human-approved graph-recorded actions (B), MCP server (C), fire drills (D).
Also built: temporal scrubber (graph state at time T from recorded event timestamps).
Skipped: LLM narrator, what-if topology edits.

Found while building:
- `algo.betweenness` is **sampled**: payment-service scored 19, 22 and 27 across processes. Fixed by pinning `samplingSeed`; documented as an estimate.
- A separate embedded FalkorDB process does **not** share writes with the app (each starts its own server on the file). So the MCP server goes through the HTTP API instead of opening the DB.
- Every drill (6 services × 2 mechanisms) is rediscovered as #1, and each decoy is rejected by topology, not by time.

## Issues found during review and fixed
1. **Unreachable changes could outrank the true cause.** For INC-2042, DEP-884 (no path to notification-service) scored 78.9 vs 79.2 for the correct cause.
   Fix: evidence terms ×0.25 without a dependency path; now 33.9 vs 79.2. Test `test_unreachable_evidence_cannot_outvote_reachability`.
2. **Evidence animation implied a non-existent link** (signal → change). Fix: the traversal now follows real edges, signal → mechanism ← config ← deployment.
3. **GPGPU shader failed to compile.** Replacing `material.defines` dropped the `resolution` define that GPUComputationRenderer injects. Fix: merge the defines. Verified in Chromium: 9,216 particles, no WebGL errors.
4. **Path tie-breaks depended on row order.** Fix: prefer sync, then fewer hops, then lexicographic path.
5. **UI:** a `.top` class collision broke the candidate cards; PixelStream rendered blank (grid column); mobile overflowed horizontally; bloom blew out the highlighted edges. All fixed and re-screenshotted.

## Validation commands and results (real output)
```
cd backend && ../.venv/bin/python -m pytest -q        → 38 passed in 0.60s (was 18 before the wow sprint)
MCP over real stdio: initialize → 8 tools listed → tools/call blast_radius returned live graph data
cd frontend && npx tsc --noEmit && npx vite build      → ok (JS 556 kB, 143 kB gzip)
curl /api/health                                       → {"graph":"ok","nodes":70,"edges":107}  (same after re-seed: idempotent)
PORT=8011 DEVROOT_DB_PATH=<fresh> ./run.sh             → health ok, UI served
Playwright (Chromium 1243, 1600×960 and 390×844):
  investigation streams 9 steps; result DEP-884 95.2; blast radius 4 services; PixelStream HUD renders;
  rollback dialog shows executed=false; memory replay; ledger click → entity card; trace shows 12 queries;
  no console or page errors; mobile scrollWidth == clientWidth (390);
  canvas getContext disabled → fallback notice shown, panels still investigate, no page errors.
```

## Unresolved limitations
- One synthetic scenario; no telemetry ingestion adapters.
- `INDICATES` / `TOUCHES` links are hand-seeded; producing them automatically is the real product problem.
- Score weights are uncalibrated; no accuracy is claimed.
- Actions are recorded in DevRoot's graph only; there is no pager or CI integration.
- No LLM (none configured). The narrative is a template over query rows.
- No live deployment: Railway trial expired; Dockerfile + render.yaml are prepared but the image was never built (no Docker locally). No demo video yet.
- Browser tests are an ad-hoc Playwright script, not committed CI.
- The GPU particle path was verified in desktop Chromium only (Metal/ANGLE). Safari/Firefox are untested.
- `/api/entity/{id}` matches without a label (fine at 70 nodes; would need a label hint at scale).
