/**
 * GraphScene — renders the FalkorDB graph and the investigation's SceneState stream.
 *
 * Nodes: one THREE.Points (ShaderMaterial; per-node colour/size/state/shape attributes).
 * Edges: one THREE.LineSegments (per-vertex colour/alpha; async edges dashed in the fragment shader).
 * Particles: GPUComputationRenderer. Particle positions live in a float render target and are advanced
 *   every frame by a fragment shader; the CPU only uploads edge endpoints + emphasis (≤256 edges).
 * Labels and the PixelStream HUD are CanvasTexture sprites drawn inside the WebGL canvas.
 * Every drawn node/edge comes from /api/graph or a SceneState; edges not present in the data are never drawn.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GPUComputationRenderer, type Variable } from 'three/examples/jsm/misc/GPUComputationRenderer.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Entity, GraphData, ParticleMode, SceneState } from './types';

const MAX_NODES = 256;
const MAX_EDGES = 256;

const COLORS: Record<string, string> = {
  service: '#d5dbe8', database: '#9db4d0', queue: '#8ea2ff', external: '#c8b48f',
  Incident: '#ff5d6c', Alert: '#ff7a59', Deployment: '#a98bff', ConfigChange: '#c4a8ff', Commit: '#8d82cf',
  MetricSignal: '#45d4e8', LogEvent: '#7fe3f0', FailureMode: '#f5b544', Runbook: '#7ad6a3', PastIncident: '#c99a5c',
};
const SHAPE: Record<string, number> = { service: 0, database: 1, queue: 3, external: 2, Deployment: 2, ConfigChange: 2, FailureMode: 3, Incident: 3 };
const EDGE_CLASS = { base: 0.2, visited: 0.45, trace: 0.55, converge: 0.75, blast: 1.0 } as const;

enum NS { Dim = 0, Normal = 1, Visited = 2, Focus = 3, Hypothesis = 4, Selected = 5 }

interface NodeRec { id: string; label: string; kind: string; name: string; pos: THREE.Vector3; target: THREE.Vector3; alert: boolean; sprite: THREE.Sprite; weight: number; frozen: boolean }
interface EdgeRec { src: string; dst: string; type: string; async: boolean }

export interface SceneOptions { onPick: (id: string | null) => void; onHover?: (id: string | null, x: number, y: number) => void; reducedMotion: boolean }

export class GraphScene {
  readonly particlesStatus: string;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private hudScene = new THREE.Scene();
  private hudCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private hud: { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; mesh: THREE.Mesh } | null = null;
  private nodes = new Map<string, NodeRec>();
  private order: string[] = [];
  private baseEdges: EdgeRec[] = [];
  private revealed: EdgeRec[] = [];
  private nodeState = new Map<string, NS>();
  private edgeClass = new Map<string, number>();
  private hot: string[] = [];          // edge keys emphasised in this step, in traversal order (directional "a>b")
  private mode: ParticleMode = 'idle';
  private alertPositions: THREE.Vector3[] = [];
  private nodePoints: THREE.Points;
  private edgeLines: THREE.LineSegments;
  private gpu: GPUComputationRenderer | null = null;
  private posVar: Variable | null = null;
  private particleMat: THREE.ShaderMaterial | null = null;
  private edgeTex: THREE.DataTexture;
  private edgeData = new Float32Array(MAX_EDGES * 2 * 4);
  private raf = 0;
  private clock = new THREE.Clock();
  private camGoal: { target: THREE.Vector3; t: number } | null = null;
  private selected: string | null = null;
  private hovered: string | null = null;
  private pixelStream = false;
  private focusCount = 0;
  private disposed = false;
  private resizeObs: ResizeObserver;

  constructor(private container: HTMLElement, private opts: SceneOptions) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x07080b, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-hidden', 'true');

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
    this.camera.position.set(0, 2, 50);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxDistance = 90;
    this.controls.minDistance = 8;
    this.scene.fog = new THREE.FogExp2(0x07080b, 0.012);
    this.scene.add(this.atmosphere());

    // Nodes
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_NODES * 3), 3));
    ng.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_NODES * 3), 3));
    ng.setAttribute('size', new THREE.BufferAttribute(new Float32Array(MAX_NODES), 1));
    ng.setAttribute('state', new THREE.BufferAttribute(new Float32Array(MAX_NODES), 1));
    ng.setAttribute('shape', new THREE.BufferAttribute(new Float32Array(MAX_NODES), 1));
    ng.setDrawRange(0, 0);
    this.nodePoints = new THREE.Points(ng, new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPR: { value: this.renderer.getPixelRatio() } },
      vertexShader: NODE_VS, fragmentShader: NODE_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.nodePoints.frustumCulled = false;
    this.nodePoints.renderOrder = 2;
    this.scene.add(this.nodePoints);

    // Edges
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_EDGES * 6), 3));
    eg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_EDGES * 8), 4));
    eg.setAttribute('dash', new THREE.BufferAttribute(new Float32Array(MAX_EDGES * 4), 2));
    eg.setDrawRange(0, 0);
    this.edgeLines = new THREE.LineSegments(eg, new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } }, vertexShader: EDGE_VS, fragmentShader: EDGE_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.edgeLines.frustumCulled = false;
    this.scene.add(this.edgeLines);

    this.edgeTex = new THREE.DataTexture(this.edgeData, MAX_EDGES, 2, THREE.RGBAFormat, THREE.FloatType);
    this.particlesStatus = this.initParticles();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.4, 0.72);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('click', this.onClick);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.loop();
  }

  // ---------------------------------------------------------------- data
  setBase(g: GraphData) {
    for (const id of [...this.nodes.keys()]) this.removeNode(id); // re-callable: drills and actions change the base graph
    const depth = new Map(g.services.map(s => [s.id, 0]));
    for (let i = 0; i < g.services.length; i++)
      for (const d of g.dependencies) depth.set(d.dst, Math.max(depth.get(d.dst)!, depth.get(d.src)! + 1));
    // pure async consumers (e.g. notification-service) sit after the queue they consume
    for (const s of g.services) {
      const out = g.dependencies.filter(d => d.src === s.id);
      const incoming = g.dependencies.some(d => d.dst === s.id);
      if (!incoming && out.length && out.every(d => d.mode === 'async'))
        depth.set(s.id, Math.max(...out.map(d => depth.get(d.dst)!)) + 1);
    }
    const maxD = Math.max(...depth.values());
    const layers = new Map<number, string[]>();
    for (const s of [...g.services].sort((a, b) => a.id.localeCompare(b.id))) {
      const d = depth.get(s.id)!;
      layers.set(d, [...(layers.get(d) ?? []), s.id]);
    }
    for (const s of g.services) {
      const layer = layers.get(depth.get(s.id)!)!;
      const i = layer.indexOf(s.id);
      const p = new THREE.Vector3((depth.get(s.id)! - maxD / 2) * 7.2, (i - (layer.length - 1) / 2) * 6.2, (i % 2 ? 1 : -1) * 1.6);
      this.addNode({ id: s.id, label: 'Service', name: s.frozen ? `${s.name} · frozen` : s.name, kind: s.kind }, p, p);
      const n = this.nodes.get(s.id)!;
      n.alert = s.alerts.length > 0;
      n.frozen = s.frozen;
      n.weight = s.betweenness;
    }
    this.baseEdges = g.dependencies.map(d => ({ src: d.src, dst: d.dst, type: 'DEPENDS_ON', async: d.mode === 'async' }));
    this.alertPositions = [...this.nodes.values()].filter(n => n.alert).map(n => n.target);
    this.apply([]);
  }

  /** Render the state after a prefix of scene states (pure function of the prefix → replay can step backwards). */
  apply(scenes: SceneState[], overlay?: Pick<SceneState, 'path' | 'focus' | 'particles'>) {
    // remove previously revealed non-service nodes, then re-reveal from the prefix
    for (const id of [...this.nodes.keys()]) if (this.nodes.get(id)!.label !== 'Service') this.removeNode(id);
    this.revealed = [];
    const visited = new Set<string>();
    for (const s of scenes) {
      for (const e of s.entities) if (!this.nodes.has(e.id)) this.placeEntity(e, s);
      for (const [a, b, t] of s.edges) if (this.nodes.has(a) && this.nodes.has(b) && !this.hasEdge(a, b)) this.revealed.push({ src: a, dst: b, type: t, async: false });
      for (const [a, b] of s.path) visited.add(key(a, b));
    }
    const last = scenes[scenes.length - 1];
    const cur = overlay ?? last;
    this.mode = cur ? cur.particles : 'idle';
    this.hot = cur ? cur.path.filter(([a, b]) => this.hasEdge(a, b)).map(([a, b]) => `${a}>${b}`) : [];
    const hotUndirected = new Set(this.hot.map(h => { const [a, b] = h.split('>'); return key(a, b); }));
    const active = scenes.length > 0 || !!overlay;
    this.edgeClass.clear();
    for (const e of this.allEdges()) {
      const k = key(e.src, e.dst);
      this.edgeClass.set(k, hotUndirected.has(k) ? EDGE_CLASS[this.mode === 'idle' ? 'trace' : this.mode]
        : visited.has(k) ? EDGE_CLASS.visited : EDGE_CLASS.base);
    }
    const focus = new Set(cur?.focus ?? []);
    const onPath = new Set([...hotUndirected].flatMap(k => k.split('|')));
    const visitedNodes = new Set([...visited].flatMap(k => k.split('|')));
    const hyp = last?.hypothesis?.id;
    this.nodeState.clear();
    for (const id of this.nodes.keys()) {
      let st = active ? NS.Dim : NS.Normal;
      if (visitedNodes.has(id)) st = NS.Visited;
      if (onPath.has(id) || focus.has(id)) st = NS.Focus;
      if (id === hyp) st = NS.Hypothesis;
      if (id === this.selected) st = NS.Selected;
      this.nodeState.set(id, st);
    }
    this.focusCount = [...this.nodeState.entries()].filter(([id, st]) => st === NS.Focus && this.nodes.get(id)!.label !== 'Service').length;
    if (cur?.focus.length) this.focusOn(cur.focus);
    if (this.pixelStream) this.drawHud(last ?? null, scenes.length);
    this.rebuild();
  }

  setPixelStream(on: boolean, scenes: SceneState[]) {
    this.pixelStream = on;
    this.controls.autoRotate = on && !this.opts.reducedMotion;
    this.controls.autoRotateSpeed = 0.35;
    if (on && !this.hud) this.hud = this.makeHud();
    if (this.hud) this.hud.mesh.visible = on;
    this.apply(scenes);
  }

  select(id: string | null) {
    this.selected = id && this.nodes.has(id) ? id : null;
    if (this.selected) this.focusOn([this.selected]);
  }

  has(id: string) { return this.nodes.has(id); }

  describe(id: string) {
    const n = this.nodes.get(id);
    return n && { id: n.id, label: n.label, kind: n.kind, name: n.name, frozen: n.frozen, alert: n.alert };
  }

  /** Frame every node currently in the scene. */
  fit() {
    const pts = [...this.nodes.values()].map(n => n.target);
    if (!pts.length) return;
    const box = new THREE.Box3().setFromPoints(pts);
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getBoundingSphere(new THREE.Sphere()).radius;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fit = Math.max(r / Math.sin(fov / 2), r / Math.sin(Math.atan(Math.tan(fov / 2) * this.camera.aspect))) * 0.82;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(dir.multiplyScalar(Math.min(fit, this.controls.maxDistance)));
    this.camGoal = null;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('click', this.onClick);
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const sc of [this.scene, this.hudScene]) sc.traverse(o => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) { (mat as THREE.SpriteMaterial).map?.dispose(); mat.dispose(); }
    });
    this.edgeTex.dispose();
    this.gpu?.dispose();
    this.composer.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    el.remove();
  }

  // ---------------------------------------------------------------- layout
  private anchors = new Map<string, number>();

  private placeEntity(e: Entity, s: SceneState) {
    // anchor = the node this entity is attached to by an edge in the same scene
    const link = s.edges.find(([a, b]) => (a === e.id && this.nodes.has(b)) || (b === e.id && this.nodes.has(a)));
    const anchorId = link ? (link[0] === e.id ? link[1] : link[0]) : null;
    let anchor = anchorId ? this.nodes.get(anchorId)!.target.clone() : new THREE.Vector3();
    const label = e.label === 'Incident' && e.status === 'resolved' ? 'PastIncident' : e.label;
    if (label === 'Incident') {
      const alerts = s.edges.filter(([a]) => a !== e.id).map(([, b]) => b);
      const svc = s.edges.filter(([a, b]) => alerts.includes(a) && this.nodes.has(b)).map(([, b]) => this.nodes.get(b)!.target);
      anchor = svc.length ? svc.reduce((acc, v) => acc.add(v), new THREE.Vector3()).divideScalar(svc.length) : anchor;
      anchor.y += 10;
    }
    if (label === 'FailureMode') {
      const n = [...this.nodes.values()].filter(x => x.label === 'FailureMode').length;
      const p = new THREE.Vector3(-13 + n * 9, -12.5, 2);
      return this.addNode({ ...e, label }, anchor, p);
    }
    const k = this.anchors.get(anchorId ?? '') ?? 0;
    this.anchors.set(anchorId ?? '', k + 1);
    const bias: Record<string, [number, number]> = {
      Alert: [Math.PI / 2, 1], Deployment: [-Math.PI / 2, 1], ConfigChange: [-Math.PI / 2, 1.6], MetricSignal: [0, 1],
      LogEvent: [Math.PI, 1], PastIncident: [-Math.PI / 2, 1.2], Runbook: [-Math.PI / 2, 1.2], Incident: [0, 0],
    };
    const [base, rScale] = bias[label] ?? [0, 1];
    const ang = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.55;
    const r = (label === 'Incident' ? 0 : 2.6 + 0.35 * k) * rScale;
    const target = anchor.clone().add(new THREE.Vector3(Math.cos(ang) * r, Math.sin(ang) * r, 2.2 + (k % 3) * 0.6));
    this.addNode({ ...e, label }, anchor.clone(), target);
  }

  private addNode(e: { id: string; label: string; name: string; kind?: string }, start: THREE.Vector3, target: THREE.Vector3) {
    if (this.nodes.size >= MAX_NODES) return;
    const kind = e.label === 'Service' ? (e.kind ?? 'service') : e.label;
    const text = e.label === 'Service' || e.label === 'FailureMode' ? e.name : `${e.id}  ${e.name ?? ''}`;
    const sprite = makeLabel(text.length > 48 ? text.slice(0, 46) + '…' : text, e.label === 'Service');
    this.scene.add(sprite);
    const rec: NodeRec = { id: e.id, label: e.label, kind, name: e.name, pos: start.clone(), target: target.clone(), alert: false, sprite, weight: 0, frozen: false };
    if (this.opts.reducedMotion) rec.pos.copy(target);
    this.nodes.set(e.id, rec);
    this.order.push(e.id);
  }

  private removeNode(id: string) {
    const n = this.nodes.get(id)!;
    this.scene.remove(n.sprite);
    n.sprite.material.map?.dispose();
    n.sprite.material.dispose();
    this.nodes.delete(id);
    this.order = this.order.filter(x => x !== id);
    this.anchors.clear();
  }

  private allEdges(): EdgeRec[] { return [...this.baseEdges, ...this.revealed]; }
  private hasEdge(a: string, b: string) { return this.allEdges().some(e => (e.src === a && e.dst === b) || (e.src === b && e.dst === a)); }

  private focusOn(ids: string[]) {
    const pts = ids.map(id => this.nodes.get(id)?.target).filter((p): p is THREE.Vector3 => !!p);
    if (!pts.length) return;
    const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
    c.multiplyScalar(0.6); // stay partly centred so context remains visible
    if (this.opts.reducedMotion) { this.controls.target.copy(c); return; }
    this.camGoal = { target: c, t: 0 };
  }

  // ---------------------------------------------------------------- buffers
  private rebuild() {
    const ng = this.nodePoints.geometry;
    const col = ng.getAttribute('color') as THREE.BufferAttribute;
    const size = ng.getAttribute('size') as THREE.BufferAttribute;
    const state = ng.getAttribute('state') as THREE.BufferAttribute;
    const shape = ng.getAttribute('shape') as THREE.BufferAttribute;
    const c = new THREE.Color();
    this.order.forEach((id, i) => {
      const n = this.nodes.get(id)!;
      c.set(n.frozen ? '#9fe7ff' : n.alert && n.label === 'Service' ? '#ff8a7a' : COLORS[n.kind] ?? '#aab');
      col.setXYZ(i, c.r, c.g, c.b);
      // service size ∝ betweenness (chokepoint score from FalkorDB algo.betweenness)
      size.setX(i, n.label === 'Service' ? 1.05 + Math.min(n.weight, 30) * 0.025 : n.label === 'Incident' ? 1.5 : n.label === 'FailureMode' ? 1.1 : 0.72);
      state.setX(i, this.nodeState.get(id) ?? NS.Normal);
      shape.setX(i, n.frozen ? 3 : SHAPE[n.kind] ?? 0);
    });
    [col, size, state, shape].forEach(a => (a.needsUpdate = true));
    ng.setDrawRange(0, this.order.length);
    this.updatePositions();
  }

  private edgeColor(cls: number): THREE.Color {
    return new THREE.Color(cls >= 1 ? '#ff8a5c' : cls >= 0.7 ? '#f5b544' : cls >= 0.5 ? '#45d4e8' : cls >= 0.4 ? '#3a8fa0' : '#56607a');
  }

  /** Called every frame: eases nodes to targets; writes node, edge and particle-edge buffers. */
  private updatePositions(dt = 1) {
    const k = 1 - Math.exp(-dt * 5);
    const ng = this.nodePoints.geometry;
    const pos = ng.getAttribute('position') as THREE.BufferAttribute;
    this.order.forEach((id, i) => {
      const n = this.nodes.get(id)!;
      n.pos.lerp(n.target, k);
      pos.setXYZ(i, n.pos.x, n.pos.y, n.pos.z);
      const st = this.nodeState.get(id) ?? NS.Normal;
      // label rules: services always; everything else only when it is the answer, selected, hovered, or one of few focused nodes
      const show = n.label === 'Service' || st === NS.Hypothesis || st === NS.Selected || id === this.hovered
        || (st === NS.Focus && this.focusCount <= 6) || (n.label === 'FailureMode' && st >= NS.Visited);
      const mat = n.sprite.material;
      mat.opacity += ((show ? (st === NS.Dim ? 0.35 : 0.92) : 0) - mat.opacity) * k;
      n.sprite.visible = mat.opacity > 0.02;
      n.sprite.position.copy(n.pos).add(new THREE.Vector3(0, n.label === 'Service' ? -1.25 : -0.85, 0));
    });
    pos.needsUpdate = true;

    // edges: hot (current step) first so particles concentrate on them
    const edges = this.allEdges();
    const hotIdx = new Map(this.hot.map((h, i) => [h, i]));
    const dir = (e: EdgeRec): [string, string] => (hotIdx.has(`${e.dst}>${e.src}`) ? [e.dst, e.src] : [e.src, e.dst]);
    const sorted = [...edges].sort((a, b) => (rank(a) - rank(b)));
    function rank(e: EdgeRec) { const h = hotIdx.get(`${e.src}>${e.dst}`) ?? hotIdx.get(`${e.dst}>${e.src}`); return h ?? 1e6; }
    const eg = this.edgeLines.geometry;
    const ep = eg.getAttribute('position') as THREE.BufferAttribute;
    const ec = eg.getAttribute('color') as THREE.BufferAttribute;
    const ed = eg.getAttribute('dash') as THREE.BufferAttribute;
    const tex = this.edgeData;
    let n = 0;
    for (const e of sorted) {
      const [s, d] = dir(e);
      const a = this.nodes.get(s), b = this.nodes.get(d);
      if (!a || !b || n >= MAX_EDGES) continue;
      const cls = this.edgeClass.get(key(e.src, e.dst)) ?? EDGE_CLASS.base;
      const c = this.edgeColor(cls);
      const alpha = cls >= 0.5 ? 0.95 : cls >= 0.4 ? 0.5 : this.hot.length ? 0.16 : 0.32;
      ep.setXYZ(n * 2, a.pos.x, a.pos.y, a.pos.z); ep.setXYZ(n * 2 + 1, b.pos.x, b.pos.y, b.pos.z);
      ec.setXYZW(n * 2, c.r, c.g, c.b, alpha); ec.setXYZW(n * 2 + 1, c.r, c.g, c.b, alpha);
      const len = a.pos.distanceTo(b.pos);
      ed.setXY(n * 2, 0, e.async ? 1 : 0); ed.setXY(n * 2 + 1, len, e.async ? 1 : 0);
      // particle edge texture: row 0 = start.xyz + class, row 1 = end.xyz + speed
      tex.set([a.pos.x, a.pos.y, a.pos.z, cls], n * 4);
      tex.set([b.pos.x, b.pos.y, b.pos.z, cls >= 0.5 ? 0.55 : e.async ? 0.05 : 0.11], (MAX_EDGES + n) * 4);
      n++;
    }
    eg.setDrawRange(0, n * 2);
    [ep, ec, ed].forEach(a => (a.needsUpdate = true));
    this.edgeTex.needsUpdate = true;
    const hot = Math.min(this.hot.length, n);
    for (const u of [this.posVar?.material.uniforms, this.particleMat?.uniforms]) {
      if (!u) continue;
      u.uCount.value = n; u.uHot.value = hot;
    }
  }

  // ---------------------------------------------------------------- particles (GPGPU)
  private initParticles(): string {
    if (this.opts.reducedMotion) return 'off (prefers-reduced-motion)';
    const gl = this.renderer.getContext();
    if (!this.renderer.capabilities.isWebGL2 || !gl.getExtension('EXT_color_buffer_float')) return 'off (no float render targets)';
    const cores = navigator.hardwareConcurrency ?? 4;
    const mobile = /Mobi|Android/i.test(navigator.userAgent);
    const SIZE = mobile || cores <= 4 ? 40 : 64; // 1600 or 4096 particles: enough to show flow, not a storm
    const gpu = new GPUComputationRenderer(SIZE, SIZE, this.renderer);
    const init = gpu.createTexture();
    const seeds = gpu.createTexture();
    const sd = seeds.image.data as unknown as Float32Array;
    let s = 1337; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647); // deterministic seeds
    for (let i = 0; i < sd.length; i += 4) { sd[i] = rnd(); sd[i + 1] = rnd(); sd[i + 2] = rnd(); sd[i + 3] = rnd(); }
    const id = init.image.data as unknown as Float32Array;
    for (let i = 0; i < id.length; i += 4) id[i + 3] = sd[i + 3];
    const v = gpu.addVariable('texPos', PARTICLE_SIM, init);
    gpu.setVariableDependencies(v, [v]);
    const u = v.material.uniforms;
    Object.assign(u, {
      tEdges: { value: this.edgeTex }, tSeeds: { value: seeds }, uDt: { value: 0 }, uTime: { value: 0 },
      uCount: { value: 0 }, uHot: { value: 0 }, uAlerts: { value: [0, 1, 2, 3].map(() => new THREE.Vector3(1e4, 0, 0)) },
      uDisturb: { value: 0 },
    });
    Object.assign(v.material.defines, { MAXE: MAX_EDGES.toFixed(1) });
    const err = gpu.init();
    if (err) return `off (${err})`;
    this.gpu = gpu; this.posVar = v;

    const geo = new THREE.BufferGeometry();
    const ref = new Float32Array(SIZE * SIZE * 2);
    for (let i = 0; i < SIZE * SIZE; i++) { ref[i * 2] = ((i % SIZE) + 0.5) / SIZE; ref[i * 2 + 1] = (Math.floor(i / SIZE) + 0.5) / SIZE; }
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SIZE * SIZE * 3), 3));
    geo.setAttribute('ref', new THREE.BufferAttribute(ref, 2));
    this.particleMat = new THREE.ShaderMaterial({
      uniforms: {
        tPos: { value: null }, tEdges: { value: this.edgeTex }, tSeeds: { value: seeds }, uCount: { value: 0 }, uHot: { value: 0 },
        uPR: { value: this.renderer.getPixelRatio() },
      },
      defines: { MAXE: MAX_EDGES.toFixed(1) },
      vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, this.particleMat);
    pts.frustumCulled = false;
    this.scene.add(pts);
    return `GPU simulation, ${SIZE * SIZE} particles`;
  }

  // ---------------------------------------------------------------- HUD (PixelStream in-canvas surface)
  private makeHud() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 300;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }));
    this.hudScene.add(mesh);
    const hud = { canvas, tex, mesh };
    this.hud = hud;
    this.layoutHud();
    return hud;
  }

  private layoutHud() {
    if (!this.hud) return;
    const { clientWidth: w, clientHeight: h } = this.container;
    this.hudCamera.left = 0; this.hudCamera.right = w; this.hudCamera.top = h; this.hudCamera.bottom = 0;
    this.hudCamera.updateProjectionMatrix();
    const cw = Math.min(560, w - 32), ch = cw * 300 / 1024;
    this.hud.mesh.scale.set(cw, ch, 1);
    this.hud.mesh.position.set(16 + cw / 2, h - 16 - ch / 2, 0);
  }

  private drawHud(s: SceneState | null, n: number) {
    if (!this.hud) return;
    const ctx = this.hud.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, 1024, 300);
    ctx.fillStyle = 'rgba(12,14,19,0.82)'; roundRect(ctx, 0, 0, 1024, 300, 22); ctx.fill();
    ctx.strokeStyle = 'rgba(169,139,255,0.35)'; ctx.lineWidth = 2; roundRect(ctx, 1, 1, 1022, 298, 22); ctx.stroke();
    const phases = ['intent', 'context', 'frontier', 'candidates', 'evidence', 'history', 'ranking', 'blast', 'complete'];
    const idx = s ? phases.indexOf(s.phase) : -1;
    phases.forEach((p, i) => {
      ctx.fillStyle = i < idx ? '#3a8fa0' : i === idx ? '#45d4e8' : '#2a2f3b';
      ctx.fillRect(40 + i * 104, 34, 92, 6);
    });
    ctx.font = '600 22px "IBM Plex Mono", monospace'; ctx.fillStyle = '#8a93a8';
    ctx.fillText(s ? `STEP ${s.seq} · ${s.phase.toUpperCase()}` : 'AWAITING INVESTIGATION', 40, 82);
    const status = s?.evidence_status ?? 'collecting';
    ctx.fillStyle = status === 'supported' ? '#f5b544' : status === 'insufficient' ? '#ff7a59' : '#45d4e8';
    ctx.textAlign = 'right'; ctx.fillText(status === 'supported' ? 'HYPOTHESIS · EVIDENCE-SUPPORTED' : status.toUpperCase(), 984, 82); ctx.textAlign = 'left';
    ctx.font = '600 36px "IBM Plex Sans", system-ui, sans-serif'; ctx.fillStyle = '#eef1f7';
    ctx.fillText(clip(ctx, s?.title ?? 'Ask DevRoot to investigate an incident', 944), 40, 134);
    ctx.font = '400 25px "IBM Plex Sans", system-ui, sans-serif'; ctx.fillStyle = '#b7bfd0';
    wrap(ctx, s?.annotation ?? 'The scene is driven only by investigation state streamed from FalkorDB queries.', 40, 178, 944, 34, 3);
    ctx.font = '500 18px "IBM Plex Mono", monospace'; ctx.fillStyle = '#5d6578';
    ctx.fillText(`agent-directed local WebGL · ${n} state update(s) · no model-generated frames`, 40, 282);
    this.hud.tex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- loop & input
  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    (this.nodePoints.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    (this.edgeLines.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    if (this.camGoal) {
      this.camGoal.t += dt;
      this.controls.target.lerp(this.camGoal.target, 1 - Math.exp(-dt * 3));
      if (this.camGoal.t > 2) this.camGoal = null;
    }
    this.controls.update();
    this.updatePositions(dt);
    if (this.gpu && this.posVar && this.particleMat) {
      const u = this.posVar.material.uniforms;
      u.uDt.value = dt; u.uTime.value = t;
      this.alertPositions.slice(0, 4).forEach((p, i) => u.uAlerts.value[i].copy(p));
      u.uDisturb.value = this.alertPositions.length ? 1 : 0;
      this.gpu.compute();
      this.particleMat.uniforms.tPos.value = this.gpu.getCurrentRenderTarget(this.posVar).texture;
    }
    this.composer.render();
    if (this.pixelStream && this.hud) {
      this.renderer.autoClear = false;
      this.renderer.render(this.hudScene, this.hudCamera);
      this.renderer.autoClear = true;
    }
  };

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w / 2, h / 2);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.layoutHud();
  }

  private pick(ev: PointerEvent | MouseEvent): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3();
    let best: string | null = null, bestD = 22;
    for (const [id, n] of this.nodes) {
      v.copy(n.pos).project(this.camera);
      if (v.z > 1) continue;
      const d = Math.hypot((v.x + 1) / 2 * r.width - (ev.clientX - r.left), (1 - v.y) / 2 * r.height - (ev.clientY - r.top));
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  private onMove = (ev: PointerEvent) => {
    const id = this.pick(ev);
    if (id !== this.hovered || id) {
      const r = this.renderer.domElement.getBoundingClientRect();
      this.opts.onHover?.(id, ev.clientX - r.left, ev.clientY - r.top);
    }
    this.hovered = id;
    this.renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
  };
  private onClick = (ev: MouseEvent) => this.opts.onPick(this.pick(ev));
  private onVisibility = () => { if (!document.hidden) this.clock.getDelta(); };

  private atmosphere(): THREE.Points {
    // static depth dust: gives parallax/depth, carries no data
    const n = 1400, p = new Float32Array(n * 3);
    let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) { p[i * 3] = (rnd() - 0.5) * 160; p[i * 3 + 1] = (rnd() - 0.5) * 100; p[i * 3 + 2] = -20 - rnd() * 80; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: 0x2a3042, size: 0.25, transparent: true, opacity: 0.6, depthWrite: false }));
  }
}

function key(a: string, b: string) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

function makeLabel(text: string, primary: boolean): THREE.Sprite {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = `${primary ? 600 : 500} 40px ${primary ? '"IBM Plex Sans", system-ui' : '"IBM Plex Mono", monospace'}`;
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(text).width) + 24; c.height = 56;
  ctx.font = font; ctx.fillStyle = primary ? '#c9cfdb' : '#9aa3b5'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, 28);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
  const h = primary ? 0.62 : 0.44;
  s.scale.set(h * c.width / c.height, h, 1);
  s.renderOrder = 3;
  return s;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function clip(ctx: CanvasRenderingContext2D, t: string, w: number) {
  while (ctx.measureText(t).width > w && t.length > 4) t = t.slice(0, -2);
  return t;
}
function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, lh: number, max: number) {
  const words = text.split(' '); let line = '', n = 0;
  for (const word of words) {
    if (ctx.measureText(line + word).width > w && line) {
      ctx.fillText(n === max - 1 ? clip(ctx, line + '…', w) : line, x, y + n * lh);
      if (++n >= max) return;
      line = '';
    }
    line += word + ' ';
  }
  ctx.fillText(line, x, y + n * lh);
}

// ---------------------------------------------------------------- shaders
const NODE_VS = /* glsl */ `
attribute vec3 color; attribute float size; attribute float state; attribute float shape;
uniform float uTime; uniform float uPR;
varying vec3 vColor; varying float vState; varying float vShape;
void main() {
  vColor = color; vState = state; vShape = shape;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float s = size * (state < 0.5 ? 0.8 : state > 2.5 ? 1.35 : 1.0);
  if (state > 3.5 && state < 4.5) s *= 1.25 + 0.12 * sin(uTime * 3.0);
  gl_PointSize = s * uPR * 520.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const NODE_FS = /* glsl */ `
varying vec3 vColor; varying float vState; varying float vShape;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  if (vShape > 0.5 && vShape < 1.5) d = max(abs(p.x), abs(p.y)) * 1.05;      // database: square
  if (vShape > 1.5 && vShape < 2.5) d = (abs(p.x) + abs(p.y)) * 0.85;        // external/change: diamond
  float core = smoothstep(0.42, 0.34, d);
  float ring = (vShape > 2.5) ? smoothstep(0.08, 0.0, abs(d - 0.38)) : 0.0;  // queue/mechanism/incident: ring
  float halo = smoothstep(1.0, 0.2, d) * 0.35;
  float a = (vShape > 2.5 ? ring + core * 0.35 : core) + halo;
  float k = vState < 0.5 ? 0.22 : vState < 1.5 ? 0.8 : vState < 2.5 ? 0.7 : 1.25;
  vec3 c = vColor * k;
  if (vState > 3.5) { c = mix(c, vec3(1.0, 0.72, 0.27), vState > 4.5 ? 0.25 : 0.6) * 1.5; a += smoothstep(0.1, 0.0, abs(d - 0.7)) * 0.9; }
  if (a < 0.01) discard;
  gl_FragColor = vec4(c, a);
}`;
const EDGE_VS = /* glsl */ `
attribute vec4 color; attribute vec2 dash; varying vec4 vColor; varying vec2 vDash;
void main() { vColor = color; vDash = dash; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const EDGE_FS = /* glsl */ `
varying vec4 vColor; varying vec2 vDash;
void main() {
  if (vDash.y > 0.5 && fract(vDash.x * 1.6) > 0.5) discard;  // async (queued) dependency: dashed
  gl_FragColor = vColor;
}`;
const PICK_EDGE = /* glsl */ `
float edgeIndex(vec4 seed, float count, float hot) {
  // 45% of particles ride the edges emphasised by the current investigation step
  if (hot > 0.0 && seed.z < 0.45) return floor(seed.x * hot);
  return floor(seed.x * max(count, 1.0));
}`;
const PARTICLE_SIM = /* glsl */ `
uniform sampler2D tEdges; uniform sampler2D tSeeds;
uniform float uDt; uniform float uTime; uniform float uCount; uniform float uHot; uniform vec3 uAlerts[4]; uniform float uDisturb;
${PICK_EDGE}
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 p = texture2D(texPos, uv);
  vec4 seed = texture2D(tSeeds, uv);
  float ei = edgeIndex(seed, uCount, uHot);
  vec4 a = texture2D(tEdges, vec2((ei + 0.5) / MAXE, 0.25));
  vec4 b = texture2D(tEdges, vec2((ei + 0.5) / MAXE, 0.75));
  float t = p.w + uDt * b.w * (0.6 + seed.y * 0.8);
  bool wrapped = t >= 1.0;
  t = fract(t);
  vec3 lane = (vec3(seed.y, seed.w, seed.z) - 0.5) * (a.w >= 0.5 ? 0.35 : 0.6);
  vec3 target = mix(a.xyz, b.xyz, t) + lane;
  vec3 pos = wrapped || length(p.xyz) < 0.0001 ? target : mix(p.xyz, target, 1.0 - exp(-uDt * 9.0));
  // alerting services disturb nearby particles (controlled jitter)
  for (int i = 0; i < 4; i++) {
    float d = distance(pos, uAlerts[i]);
    pos += uDisturb * 0.05 * smoothstep(3.5, 0.0, d) * vec3(sin(uTime * 17.0 + seed.x * 40.0), cos(uTime * 13.0 + seed.y * 40.0), sin(uTime * 11.0 + seed.w * 40.0));
  }
  gl_FragColor = vec4(pos, t);
}`;
const PARTICLE_VS = /* glsl */ `
attribute vec2 ref;
uniform sampler2D tPos; uniform sampler2D tEdges; uniform sampler2D tSeeds; uniform float uCount; uniform float uHot; uniform float uPR;
varying vec3 vColor; varying float vAlpha;
${PICK_EDGE}
void main() {
  vec4 p = texture2D(tPos, ref);
  vec4 seed = texture2D(tSeeds, ref);
  float ei = edgeIndex(seed, uCount, uHot);
  float cls = texture2D(tEdges, vec2((ei + 0.5) / MAXE, 0.25)).w;
  vColor = cls >= 0.95 ? vec3(1.0, 0.55, 0.36) : cls >= 0.7 ? vec3(1.0, 0.72, 0.27) : cls >= 0.5 ? vec3(0.27, 0.83, 0.91)
         : cls >= 0.4 ? vec3(0.23, 0.56, 0.63) : vec3(0.36, 0.40, 0.52);
  float hotEdge = step(0.5, cls);
  vAlpha = sin(p.w * 3.14159) * mix(uHot > 0.0 ? 0.12 : 0.3, 0.42, hotEdge) * step(ei, uCount - 1.0);
  vec4 mv = modelViewMatrix * vec4(p.xyz, 1.0);
  gl_PointSize = mix(1.3, 2.0, hotEdge) * uPR * 60.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const PARTICLE_FS = /* glsl */ `
varying vec3 vColor; varying float vAlpha;
void main() {
  float d = length(gl_PointCoord * 2.0 - 1.0);
  float a = smoothstep(1.0, 0.0, d) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
}`;
