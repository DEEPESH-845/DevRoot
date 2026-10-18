# DevRoot — Design Audit (before redesign, 2026-10-18 21:15 IST)

Stack inspected: Vite 6 + TypeScript (no UI framework), a single `index.html` with a 3-column CSS grid, `main.ts` (state, SSE, string-template panels),
`scene.ts` (Three.js 0.170: Points + LineSegments shaders, GPUComputationRenderer particles, UnrealBloom, CanvasTexture labels, screen-space picking),
`styles.css` (ad-hoc custom properties, ~25 one-off hex values). Build: `tsc --noEmit` + `vite build` pass. No routing. No component library.
Screenshots: `docs/screens/before-overview.png`, `docs/screens/before-investigation.png`.

## Five highest-impact problems
1. **Information architecture: there is no "what is happening" moment.** *(IA)*
   The app opens on three equal-weight columns: a 300 px input/examples/drill/incidents/memory column, a canvas, and an empty findings column.
   There is no overview, no incident header and no navigation. The current incident appears only as a small chip after an investigation runs.
2. **The diagnosis is buried.** *(IA / visual)*
   The answer sits in a 7-line prose paragraph inside the right column. The candidate cards, actions and drill verdict stack below it,
   so you have to scroll a 420 px column to see "what, why, how sure". The hypothesis and supporting-evidence states use the same amber treatment.
3. **The graph is hard to read.** *(Visual / interaction)*
   Every focused evidence node shows a monospace label, so labels overlap badly around payment-service and the failure-mode row.
   The graph only fills part of the canvas, and there is no fit, reset or hover summary. The legend shows colour dots, but the nodes encode type by *shape*.
4. **The canvas overlays collide.** *(Visual)*
   The replay step strip, legend and status line sit on top of the graph. The timeline below is compressed (10:12–14:25 with most events in the last 15 minutes),
   and its scrubber label overlaps the axis labels.
5. **Accessibility and state gaps.** *(A11y / states)*
   - The tabs have no arrow-key navigation, and stance (supports / symptom / context) is mostly colour-only.
   - There is no hover or tooltip feedback for canvas nodes.
   - The loading state only pulses a dot.
   - There is no investigation-level status (running / complete / failed) visible next to the incident.

## Other findings
- *Performance:* 9,216 particles plus bloom is more than the story needs, and idle particles compete with the investigation path. Rendering already pauses on hidden tabs.
- *Technical constraint:* one WebGL renderer must persist across views; the renderer is not recreated.

## Plan
Tokens → shell with a sidebar and four real views (Overview, Investigation, Fire drills, History) → an investigation header plus a diagnosis-first panel →
graph legibility (label rules, hover card, fit/reset, shape legend) → a single transport bar (replay + time travel) → responsive and a11y pass.
