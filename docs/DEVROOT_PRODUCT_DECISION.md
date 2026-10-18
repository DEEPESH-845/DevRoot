# DevRoot — Product Decision

## Ideation scores (1–10)
Dimensions: Pain · Practical · Differentiation · Graph-need · Graph-reasoning · Feasibility(6h) · Demo reliability · Novelty · Judge-ease · Product potential

| | Direction | P | Pr | D | GN | GR | F | DR | N | J | PP | Σ | Biggest weakness |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | Dependency-graph RCA | 9 | 8 | 4 | 8 | 7 | 9 | 9 | 4 | 8 | 7 | 73 | Crowded; topology alone rarely identifies a cause |
| **B** | **Cross-change investigation (alerts↔changes↔services↔owners↔history)** | 9 | 9 | 7 | 10 | 9 | 7 | 9 | 6 | 8 | 9 | **83** | Needs consistent seeded data to be convincing |
| C | Blast radius | 7 | 8 | 4 | 9 | 6 | 10 | 10 | 3 | 9 | 6 | 72 | Reachability ≠ outage; thin on its own |
| D | Temporal reconstruction | 7 | 7 | 5 | 5 | 4 | 7 | 8 | 5 | 7 | 6 | 61 | Mostly a timeline; weak graph need |
| E | Counterfactual rollback | 8 | 6 | 7 | 7 | 6 | 6 | 7 | 7 | 6 | 7 | 67 | Can't honestly predict recovery without a model |
| F | Pre-deploy change risk | 8 | 8 | 6 | 8 | 7 | 5 | 6 | 6 | 6 | 8 | 68 | No incident to demo; risk scores unvalidated |
| G | Knowledge-aware debugging | 7 | 7 | 6 | 8 | 7 | 5 | 6 | 6 | 5 | 7 | 64 | Broad surface; hard to finish |
| H | Flipbook-style pixel surface | 3 | 2 | 9 | 1 | 1 | 2 | 3 | 9 | 5 | 3 | 38 | No public provider; zero diagnostic value alone |
| I | Forensic traversal replay | 6 | 6 | 8 | 8 | 7 | 8 | 9 | 7 | 9 | 6 | 74 | Only as good as the investigation it replays |
| J | Persistent investigation memory | 6 | 7 | 5 | 6 | 5 | 8 | 8 | 4 | 5 | 7 | 61 | Useless without a strong core |

## Decision
**B as the core, with C, I and E as projections of the same investigation; H as the presentation layer; J as a thin write-back.**
No pivot: the existing concept (RCA) is right, but A alone is a commodity. The graph earns its place by joining
*changes* to *symptoms* through *dependency paths* and *mechanisms* — a join that is a multi-hop traversal, not a lookup.

- **Product:** DevRoot investigates an active incident by traversing FalkorDB from alert → symptom service → its sync dependencies →
  changes on those services in the incident window → signals that indicate the mechanism the change touches → past incidents
  with that mechanism. It ranks candidate changes with a transparent heuristic, computes blast radius, and previews a rollback scenario.
- **Primary workflow:** On-call opens DevRoot → selects/asks about INC-2041 → watches the investigation stream → reads the ranked
  hypothesis with evidence and contradictions → checks blast radius → replays the traversal → opens rollback preview.
- **Persona:** On-call backend engineer at a 50–300 engineer company, paged for a symptom in a service they may not own.
- **Problem:** The page fires on the service that *hurts* (checkout), not the one that *changed* (payment). Correlating deploy logs,
  config history, dashboards and ownership across tools is the slow part of MTTR.
- **Why a graph:** The causal candidate set is "changes on services reachable from the symptom through synchronous dependencies,
  within a time window, whose touched mechanism matches observed signals." That is a bounded variable-length path query joined with
  temporal and mechanism edges. Without the graph, the notification-service config change (temporally closest!) cannot be
  excluded, and the payment change cannot be connected to a checkout alert.
- **Different:** Every claim carries the node ids and the exact path FalkorDB returned; contradicting evidence is first-class; the scene
  you watch is the investigation's own state stream, replayable.

### Three strongest differentiators
1. **Path-proven hypotheses** — each candidate returns the alert→cause path, supporting *and* contradicting evidence, unknowns.
2. **Forensic replay** — the recorded query trace (Cypher, params, row counts, timings) drives a replayable WebGL scene.
3. **Mechanism matching** — `(change)-[:TOUCHES]->(FailureMode)<-[:INDICATES]-(signal)` separates "recent change" from "plausible cause".

### Rejected
- **H as a real pixel stream:** Flipbook has no public SDK/API; its stream is a hosted video model (LTX) on GPU infra. Not integrable in
  6 h and would add no diagnostic value. Built instead: agent-directed local WebGL rendering, labelled as such.
- **F (pre-deploy risk):** no incident narrative; scores would be unvalidated guesses.
- **Multi-agent / LLM planner:** no provider configured; a bounded deterministic plan is more defensible and reproducible.

## Feature breakdown
- **Must:** FalkorDB schema + idempotent seed; 6 investigation queries; ranked candidates w/ evidence/contradictions/paths;
  blast radius; SSE investigation stream; Three.js graph of real entities; GPU particles; evidence ledger; graph-unavailable state; tests; README.
- **Should:** Forensic replay; PixelStream mode (scene-state-driven, in-canvas annotations); rollback preview; investigation write-back to graph.
- **Optional:** LLM narrator (only if key present, citation-validated); live deployment; before/after toggle.

## Time budget (from 18:00 IST)
Backend + seed + queries + tests 1h45 · Frontend shell + Three.js + particles 2h15 · PixelStream/replay/rollback 45m ·
Validation + docs 45m · Buffer 30m.
