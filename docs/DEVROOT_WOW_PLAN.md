# DevRoot — Wow-factor sprint (2026-10-18, 20:50 → 23:20 IST)

Scored against the Track 01 key focus: multi-hop reasoning · graph algorithms as agent tools · tool selection through MCP ·
**actions based on what the graph shows** · explainable results. Scores 1–10 (Track fit / Demo impact / Feasibility in 2.5 h).

| # | Idea | Fit | Demo | Feas. | Decision | Biggest weakness |
|---|---|---|---|---|---|---|
| A | **Graph-algorithm criticality**: `algo.betweenness` + `algo.pageRank` as agent tools; blast radius ranks exposure by chokepoint score; node size ∝ betweenness | 9 | 6 | 10 | **Build** | Synthetic topology is small |
| B | **Agent actions with human approval**: page the owner, freeze deploys on the blast radius, open a rollback change request. Targets are *derived by queries*; approved actions are written to the graph as `(:Action)` and change what the graph shows (frozen services) | 10 | 9 | 8 | **Build** | No real pager/CI integration (recorded in the graph only, stated plainly) |
| C | **MCP server**: the same tools (investigate, blast radius, criticality, rollback, entity, record_action) callable from Claude Code / Desktop | 10 | 8 | 8 | **Build** | Needs a client to demo; tested in-process |
| D | **Fire drill**: inject a fresh incident on *any* service/mechanism. The symptom service is chosen by a graph query (an upstream caller); the agent must rediscover the cause. Proves nothing is hard-coded to INC-2041 | 9 | 10 | 7 | **Build** | Generated data is still synthetic |
| E | Temporal scrubber (graph at time T) | 6 | 8 | 6 | Stretch | Mostly visual; little added reasoning |
| F | LLM narrator with id-validated citations | 5 | 6 | 7 | Skip | No key configured; would be dead code in the demo |
| G | What-if topology edits (sync→async) | 7 | 7 | 5 | Skip | Mutating topology confuses the story |

## Acceptance
- A: `/api/criticality` and blast-radius rows carry betweenness; investigation trace includes the algorithm call.
- B: actions planned only from query rows; execute requires an explicit POST; writes `(:Action)-[:TARGETS]->(...)`; frozen services render differently; tests.
- C: `python -m devroot.mcp_server` (stdio). Test lists the tools and calls `investigate` in-process.
- D: pytest runs a drill for **every** (service with a sync caller × mechanism) and asserts the agent ranks the injected change #1.
