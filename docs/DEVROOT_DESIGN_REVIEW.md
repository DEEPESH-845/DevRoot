# DevRoot — Design Review (redesign of 2026-10-18)

Goals: **immediate comprehension**, **inspectable reasoning**, **distinctive execution** where the WebGL graph explains rather than decorates.
Before: `docs/screens/before-overview.png`, `before-investigation.png`. After: `after-overview.png`, `after-investigation.png`, `after-inspector.png`, `after-mobile.png`.

## Problems found (detail in DEVROOT_DESIGN_AUDIT.md)
1. No "what is happening" moment: three equal columns, no overview, no incident header, no navigation.
2. The diagnosis was buried in a prose paragraph in a scrolling side column. Hypothesis and evidence states shared one amber treatment.
3. Graph legibility: overlapping monospace labels, no fit/reset/hover, and a legend that encoded colour while the nodes encode shape.
4. Overlays collided on the canvas (replay strip, legend, status), and the timeline was compressed and overlapping.
5. Accessibility and state gaps: tabs without arrow keys, colour-only stances, a weak loading state, no visible run status.

## Design decisions
- **Tokens** (`frontend/src/styles.css` `:root`): graphite surfaces (#0f1117 / #151821 / #12141b / #0b0d12) and warm text (#ece8e1).
  Each accent has one meaning: violet = DevRoot and actions, cyan = active traversal, amber = hypothesis (never shown as verified),
  red = critical, green = healthy or recorded. There are 9 type tokens, a 6-step spacing scale, and 4 radii.
- **Type:** IBM Plex Sans for the interface. IBM Plex Mono only for ids, timestamps, Cypher and numbers. Narrative text is sans; machine evidence is mono.
- **Removed generic tells:** all-caps eyebrow labels, gradient washes, a card around everything, middle-dot meta strings in headings.
- **The one bold move — the proof chain:** the diagnosis is drawn as the graph path FalkorDB returned
  (`ALR-9001 FIRED_ON checkout-service DEPENDS_ON payment-service ← DEPLOYED_TO DEP-884 SHIPS CFG-311 TOUCHES pool-exhaustion ← INDICATES LOG-7710 …`).
  Every hop is a button that focuses that node in WebGL, and "Show on graph" lights the same path with converging particles.
- **Status vocabulary:** "Leading hypothesis, supported by graph evidence, not verified" / "Insufficient evidence" / "Investigating" / "Stopped".
  Badges carry a glyph (?, !, ✓, pulse), so states don't rely on colour alone. "Verified" is never displayed, because nothing is verified.

## Screens and components changed
- **Shell:** a sidebar with wordmark, data disclaimer and 4 real views (Overview, Investigation, Fire drills, History), plus a live FalkorDB / particle status footer.
  Hash routing; the single WebGL renderer persists across views.
- **Overview:** open incidents with severity, start time and the last *unverified* hypothesis; chokepoints from `algo.betweenness`; a primary
  "Investigate INC-2041" and a secondary "Explore service graph".
- **Investigation:**
  - Compact header: severity, id, title, status badge, alerting services, start time, and a single-line ask box (duplicate submits blocked).
  - Diagnosis first: cause, timing relative to onset, score with term breakdown labelled heuristic, proof chain, +/−/? reasons, next verification step,
    then Blast radius / Preview rollback / Proposed actions.
  - Details in keyboard-navigable tabs: Candidates, Evidence, Blast radius, Actions, Queries.
- **Fire drills and History** have their own panels; history shows recorded actions and can lift freezes.
- **Transport bar:** moved below the graph (no longer over it). Replay controls, phase steps, and a time-travel track with event ticks and an onset marker.
- **Inspector:** floats over the graph without leaving the investigation, shows the real node's properties and relationships (every neighbour clickable),
  offers contextual Blast radius / Preview rollback, and closes with Esc.
- **Hover card** for canvas nodes (name, id, type, alerting/frozen).
- **New endpoint:** `GET /api/actions` (History view).

## Rendering and motion
- **Label rules:** service names always; other labels only for the hypothesis, the selected or hovered node, or when ≤6 non-service nodes are focused.
  Mechanism labels show the name only.
- **Fit and Reset** frame every node from its bounding sphere.
- **Particle budget:** cut from 9,216 to 4,096 (1,600 on mobile or ≤4-core). This is still GPU-simulated (GPUComputationRenderer); idle flow is dimmer, so the active path stands out.
- **The canvas label is honest:** queries finish in ~30 ms, so once the result is in, the phase badge reads "Replay n of 9", not live progress.
- **Motion is tied to state:** each step reveals what its query returned. Errors stop the timer and the animation. No celebratory motion.
  Reduced motion turns particles off, applies states instantly and removes CSS animation.

## Accessibility and performance
- A visible focus ring on every control; arrow keys move between tabs; `/` focuses the ask box; ←/→ step the replay; Esc closes the inspector.
- An `aria-live` region announces each step and the final hypothesis. The scrubber has an `aria-valuetext`. Every finding is also present outside the canvas.
- WebGL failure → a notice, and the full investigation still works (verified with `getContext` disabled). Animation pauses when the tab is hidden.

## Commands run and results observed
```
cd frontend && npx tsc --noEmit && npx vite build     → pass
cd backend && ../.venv/bin/python -m pytest -q          → 38 passed
Playwright (Chromium 1243):
  1600×960: overview → investigate INC-2041 → proof chain → "Show on graph" → hop CFG-311 opens inspector with real props
            → tab arrow-key nav → no console errors
  empty state, "Kubernetes etcd quorum loss" → "Nothing to investigate" callout
  fire drill → ✓ ranked DEP-D1 first; approve freeze → History lists it → lift → remove drills (8 nodes)
  390×844: scrollWidth 390 (was 571 before fixing the grid min-width); diagnosis readable
  WebGL disabled → fallback notice + full diagnosis; reduced-motion → particles off, final state immediately
```

## Remaining limitations
- Labels are CanvasTexture sprites; at dense zoom-out, service labels can still touch.
- The hover card uses screen-space picking within 22 px; overlapping evidence nodes resolve to the nearest one.
- Replay, PixelStream and time travel share one scene state. Switching between them resets overlays rather than layering them.
- The overview graph and the investigation graph are the same canvas; there is no separate "incident neighbourhood" preview.
- Tested in Chromium only.

## Pass 2: showing FalkorDB, removing template components
- **FalkorDB lens** (bottom-left of the graph): for every replay step it shows the Cypher that produced it, with query number, rows and milliseconds.
  Steps that ran no query say so ("Ranking runs in Python over the rows above"). Overlays show their own query (blast_radius, evidence_chain,
  dependency_frontier, entity lookup). Time travel states that it filters returned rows and runs no new query.
  The backend now records which trace steps produced each `SceneState` (`queries` field).
- **Proof path typeset as Cypher:** `(ALR-9001)-[:FIRED_ON]->(checkout-service)-[:DEPENDS_ON]->(payment-service)<-[:DEPLOYED_TO]-(DEP-884)-[:SHIPS]->(CFG-311)…`
  Every node in it is clickable, and the caption says it is the path FalkorDB returned, not a summary.
- **Inside FalkorDB** (Overview): engine version (read from `MODULE LIST`), connection mode, graph name, and live node counts by label and
  relationship counts by type (`GET /api/schema`). DevRoot's own write-back records are greyed.
- **Removed:** glyph badges (?, !, ✓, pulsing dot), chip-chain hops, +/−/? marker lists, and the "How DevRoot answers" blurb.
- **Copy in an on-call voice, built from data:** "2 incidents are open. The loudest is INC-2041, checkout latency and 5xx spike, since 14:07 UTC."
  The reasons are grouped as "Why it leads / What argues against it / What we still don't know". The empty state asks "What are you seeing?".
- Verified in Chromium: lens on steps 5 and 7, the evidence chain and the inspector; mobile scrollWidth 390; no console errors; 38 tests pass.
