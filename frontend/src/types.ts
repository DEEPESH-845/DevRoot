export type Phase = 'intent' | 'context' | 'frontier' | 'candidates' | 'evidence' | 'history' | 'ranking' | 'blast' | 'complete';
export type ParticleMode = 'idle' | 'trace' | 'converge' | 'blast';

export interface Entity { id: string; label: string; name: string; [k: string]: unknown }

/** Mirrors backend `SceneState` (backend/devroot/agent.py). */
export interface SceneState {
  seq: number;
  phase: Phase;
  title: string;
  annotation: string;
  entities: Entity[];
  edges: [string, string, string][];
  path: [string, string][];
  focus: string[];
  particles: ParticleMode;
  hypothesis: { id: string; score: number; status: string } | null;
  evidence_status: 'collecting' | 'supported' | 'insufficient';
  queries?: number[];
}

export interface Service { id: string; name: string; kind: string; team: string; alerts: string[]; betweenness: number; frozen: boolean }
export interface Dependency { src: string; dst: string; mode: 'sync' | 'async'; protocol: string }
export interface Incident { id: string; name: string; severity: string; at: string; summary: string }
export interface GraphData { services: Service[]; dependencies: Dependency[]; incidents: Incident[] }

export interface Candidate {
  id: string; label: string; name: string; ts: number; at: string; service: string; service_name: string;
  score: number; rank: number; terms: Record<string, number>; explains_symptom: boolean;
  reach: { hops: number; sync: boolean; path: string[] } | null;
  supporting: string[]; contradicting: string[]; ruled_out: string[]; unknowns: string[]; next_step: string;
  contents: { id: string; rel: string; name: string; author: string | null; modules: string[]; tests: { id: string; name: string; status: string }[] }[];
  owners?: { team: string; engineers: string[] } | null;
}

export interface LedgerItem {
  id: string; kind: string; ts: number; at: string; service: string; relation: string; detail: string;
  stance: string; hypothesis?: string | null; source?: string;
}

export interface BlastRadius {
  origin: string; edges: [string, string][];
  services: { id: string; name: string; kind: string; hops: number; path: string[]; impact: string; betweenness?: number }[];
}

export interface TraceStep { step: number; query: string; cypher: string; params: Record<string, unknown>; rows: number; ms: number }

export interface Result {
  investigation_id: string; intent: { incident_id: string; matched_by: string; goals: string[]; text: string };
  incident: Entity & { ts: number; at: string; severity: string };
  symptoms: string[]; candidates: Candidate[]; top: string; evidence_status: string;
  evidence_chain: { alert: string; path: string[]; hops: number; element: string; fm: string; signals: string[] }[];
  blast_radius: BlastRadius; evidence: LedgerItem[]; narrative: string; scenes: SceneState[]; trace: TraceStep[];
  prior_investigations: { id: string; ts: number; query: string; top_candidate: string; top_score: number; status: string }[];
  llm_used: boolean;
}

export interface PlannedAction {
  type: string; name: string; rationale: string; targets: string[];
  recorded: { id: string; status: string } | null;
}
export interface ActionPlan { investigation_id: string; evidence_status: string; hypothesis: string; actions: PlannedAction[]; note: string }
export interface Drill { incident_id: string; symptom_service: string; symptom_hops: number; injected_cause: string; decoy: string | null; mechanism: string }
