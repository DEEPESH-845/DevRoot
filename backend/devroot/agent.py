"""DevRoot investigation agent: a fixed, bounded plan of read-only Cypher queries against FalkorDB.

Every candidate, path and evidence id in the result comes from a query row. Nothing here invents entities.
"""
import json
import re
import time
import uuid
from typing import Literal, Optional

from pydantic import BaseModel

from .seed import iso, t

WINDOW_BEFORE = 6 * 3600   # changes considered: up to 6 h before the incident start ...
WINDOW_AFTER = 3600        # ... and up to 1 h after (so late changes can be shown and ruled out)
SIGNAL_GRACE = 30 * 60     # signals considered until 30 min after incident start
MAX_HOPS = 4               # every variable-length traversal is capped at 4 hops

Q = {
    "open_incidents": """
MATCH (i:Incident {status: 'open'})-[:TRIGGERED_BY]->(:Alert)-[:FIRED_ON]->(s:Service)
RETURN i.id AS id, i.name AS name, i.summary AS summary, i.severity AS severity, i.ts AS ts,
       collect(DISTINCT s.name) AS services
ORDER BY ts DESC LIMIT 20""",
    "incident_context": """
MATCH (i:Incident {id: $iid})-[:TRIGGERED_BY]->(a:Alert)-[:FIRED_ON]->(s:Service)
RETURN properties(i) AS incident, properties(a) AS alert, properties(s) AS service""",
    "dependency_frontier": """
MATCH p = (s:Service)-[:DEPENDS_ON*0..4]->(d:Service)
WHERE s.id IN $symptoms
RETURN s.id AS origin, d.id AS target, length(p) AS hops, [n IN nodes(p) | n.id] AS path,
       all(r IN relationships(p) WHERE r.mode = 'sync') AS sync
ORDER BY hops LIMIT 500""",
    "candidate_changes": """
MATCH (c:Change)-[:DEPLOYED_TO|APPLIED_TO]->(s:Service)
WHERE c.ts >= $from AND c.ts <= $to AND c.env = $env
RETURN properties(c) AS change, labels(c) AS labels, s.id AS service, s.name AS service_name
ORDER BY c.ts LIMIT 50""",
    "change_contents": """
UNWIND $cids AS cid
MATCH (c:Change {id: cid})-[rel:INCLUDES|SHIPS]->(x)
OPTIONAL MATCH (x)-[:AUTHORED_BY|CHANGED_BY]->(e:Engineer)
OPTIONAL MATCH (x)-[:MODIFIES]->(m:CodeModule)
OPTIONAL MATCH (t:Test)-[:COVERS]->(m)
RETURN cid, type(rel) AS rel, properties(x) AS element, e.name AS author, properties(m) AS module, properties(t) AS test""",
    "touched_mechanisms": """
UNWIND $cids AS cid
MATCH (c:Change {id: cid})-[:SHIPS|INCLUDES*0..1]->(x)-[:TOUCHES]->(fm:FailureMode)
RETURN cid, x.id AS via, x.name AS via_name, labels(x)[0] AS via_label, fm.id AS fm, fm.name AS fm_name""",
    "scoped_signals": """
UNWIND $cids AS cid
MATCH (c:Change {id: cid})-[:DEPLOYED_TO|APPLIED_TO]->(cs:Service)-[:DEPENDS_ON*0..1]->(scope:Service)
MATCH (sig:Signal)-[:OBSERVED_IN]->(scope)
WHERE sig.ts >= c.ts AND sig.ts <= $until
OPTIONAL MATCH (sig)-[:INDICATES]->(fm:FailureMode)
RETURN DISTINCT cid, properties(sig) AS signal, labels(sig) AS labels, scope.id AS service, fm.id AS fm""",
    "mechanism_history": """
MATCH (fm:FailureMode) WHERE fm.id IN $fms
OPTIONAL MATCH (rb:Runbook)-[:MITIGATES]->(fm)
OPTIONAL MATCH (p:Incident {status: 'resolved'})-[:EXHIBITED]->(fm)
RETURN fm.id AS fm, fm.name AS name, collect(DISTINCT properties(rb)) AS runbooks,
       collect(DISTINCT properties(p)) AS incidents""",
    "evidence_chain": """
MATCH (i:Incident {id: $iid})-[:TRIGGERED_BY]->(a:Alert)-[:FIRED_ON]->(s:Service)
MATCH p = (s)-[:DEPENDS_ON*0..4]->(cs:Service)<-[:DEPLOYED_TO|APPLIED_TO]-(c:Change {id: $cid})
WHERE all(r IN relationships(p) WHERE type(r) <> 'DEPENDS_ON' OR r.mode = 'sync')
MATCH (c)-[:SHIPS|INCLUDES*0..1]->(x)-[:TOUCHES]->(fm:FailureMode)<-[:INDICATES]-(sig:Signal)
WHERE sig.ts >= c.ts
RETURN a.id AS alert, [n IN nodes(p) | n.id] AS path, length(p) AS hops, x.id AS element, fm.id AS fm,
       collect(DISTINCT sig.id) AS signals
ORDER BY hops LIMIT 10""",
    "blast_radius": """
MATCH p = (u:Service)-[:DEPENDS_ON*1..4]->(t:Service {id: $sid})
RETURN u.id AS service, u.name AS name, u.kind AS kind, length(p) AS hops, [n IN nodes(p) | n.id] AS path,
       all(r IN relationships(p) WHERE r.mode = 'sync') AS sync
ORDER BY hops LIMIT 200""",
    "betweenness": """
CALL algo.betweenness({nodeLabels: ['Service'], relationshipTypes: ['DEPENDS_ON'], samplingSize: 2000, samplingSeed: 42})
YIELD node, score
RETURN node.id AS id, score ORDER BY score DESC""",
    "pagerank": """
CALL algo.pageRank('Service', 'DEPENDS_ON') YIELD node, score
RETURN node.id AS id, score ORDER BY score DESC""",
    "ownership": """
MATCH (s:Service {id: $sid})-[:OWNED_BY]->(t:Team)
OPTIONAL MATCH (e:Engineer)-[:MEMBER_OF]->(t)
RETURN t.id AS team_id, t.name AS team, collect(e.name) AS engineers""",
    "prior_investigations": """
MATCH (v:Investigation)-[:INVESTIGATED]->(:Incident {id: $iid})
RETURN v.id AS id, v.ts AS ts, v.query AS query, v.top_candidate AS top_candidate, v.top_score AS top_score,
       v.status AS status
ORDER BY ts DESC LIMIT 10""",
}

Q_WRITE_INVESTIGATION = """
MATCH (i:Incident {id: $iid})
CREATE (v:Investigation {id: $id, name: $name, ts: $ts, query: $query, status: 'hypothesis',
                         top_candidate: $top, top_score: $score, record: $record})
CREATE (v)-[:INVESTIGATED]->(i)
WITH v UNWIND $hyps AS h
MATCH (c:Change {id: h.id})
CREATE (v)-[:HYPOTHESIZED {rank: h.rank, score: h.score}]->(c)"""

GOALS = {
    "root_cause": ["cause", "why", "root", "broke", "investigate"],
    "blast_radius": ["affect", "impact", "blast", "downstream", "upstream", "radius"],
    "evidence": ["evidence", "prove", "show", "path"],
    "rollback": ["rollback", "roll back", "revert", "undo"],
}
STOP = set("the a an of in on to and or for after before latest find show me most likely what which is was".split())


class AgentError(Exception):
    def __init__(self, code: str, message: str, status: int = 404):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class SceneState(BaseModel):
    """Contract between the investigation engine and the renderer. One per investigation step."""
    seq: int
    phase: Literal["intent", "context", "frontier", "candidates", "evidence", "history", "ranking", "blast", "complete"]
    title: str
    annotation: str
    entities: list[dict] = []          # nodes revealed by this step (from query rows)
    edges: list[list[str]] = []        # [src, dst, TYPE] revealed by this step
    path: list[list[str]] = []         # edges traversed in this step, in order [src, dst]
    focus: list[str] = []
    particles: Literal["idle", "trace", "converge", "blast"] = "trace"
    hypothesis: Optional[dict] = None  # {"id", "score", "status": "hypothesis"}
    evidence_status: Literal["collecting", "supported", "insufficient"] = "collecting"
    queries: list[int] = []            # trace step numbers (FalkorDB queries) that produced this scene


def _rows(res) -> list[dict]:
    names = [h[1] for h in res.header]
    return [dict(zip(names, (dict(v) if hasattr(v, "keys") else v for v in row))) for row in res.result_set]


def _tokens(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", s.lower()) if w not in STOP and len(w) > 2}


def parse_intent(text: str, open_incidents: list[dict]) -> dict:
    text = (text or "").strip()
    low = text.lower()
    goals = [g for g, words in GOALS.items() if any(w in low for w in words)] or ["root_cause"]
    m = re.search(r"\binc-\d{3,6}\b", low)
    if m:
        return {"incident_id": m.group().upper(), "matched_by": "explicit incident id", "goals": goals, "text": text}
    if not open_incidents:
        return {"incident_id": None, "matched_by": "no open incidents in graph", "goals": goals, "text": text}
    if not text:
        top = open_incidents[0]
        return {"incident_id": top["id"], "matched_by": "most recent open incident", "goals": goals, "text": text}
    q = _tokens(text)
    scored = []
    for inc in open_incidents:
        vocab = _tokens(" ".join([inc["name"], inc.get("summary") or "", *inc["services"]]).replace("-", " "))
        scored.append((len(q & vocab), inc["ts"], inc["id"], sorted(q & vocab)))
    scored.sort(reverse=True)
    best = scored[0]
    if best[0] == 0:
        return {"incident_id": None, "matched_by": "no open incident matches the request", "goals": goals, "text": text}
    return {"incident_id": best[2], "matched_by": f"keyword overlap: {', '.join(best[3])}", "goals": goals, "text": text}


def score_candidate(change_ts: int, incident_ts: int, reach: Optional[dict], matched: list[dict],
                    documented: bool, history: bool) -> dict:
    """Transparent heuristic (max 100). NOT a probability; terms are documented in README."""
    dt = incident_ts - change_ts
    temporal = round(20 * (1 - dt / WINDOW_BEFORE), 1) if 0 <= dt <= WINDOW_BEFORE else 0.0
    if reach is None:
        reachability = 0
    elif reach["sync"]:
        reachability = max(0, 20 - 4 * reach["hops"])
    else:
        reachability = 4
    kinds = {s["kind"] for s in matched}
    services = {s["service"] for s in matched}
    # Evidence terms say "this change is causing *a* problem". With no dependency path to the symptom it cannot
    # explain *this* problem, so they are discounted rather than allowed to outvote reachability.
    relevance = 1.0 if reach is not None else 0.25
    corroboration = (min(20, 10 * len(kinds)) + (10 if len(services) >= 2 else 0)) * relevance
    mechanism = ((20 if documented else 10) if matched else 0) * relevance
    hist = (10 if (history and matched) else 0) * relevance
    terms = {"temporal": temporal, "reachability": reachability, "corroboration": corroboration,
             "mechanism": mechanism, "history": hist}
    return {"score": round(sum(terms.values()), 1), "terms": terms, "relevance": relevance}


def _mins(seconds: int) -> int:
    return round(abs(seconds) / 60)


class Investigation:
    def __init__(self, g, text: str):
        self.g, self.text = g, (text or "")[:500]
        self.id = "INV-" + uuid.uuid4().hex[:8]
        self.trace: list[dict] = []
        self.scenes: list[dict] = []
        self._shown = 0

    def q(self, name: str, params: dict) -> list[dict]:
        t0 = time.perf_counter()
        rows = _rows(self.g.ro_query(Q[name], params, timeout=5000))
        self.trace.append({"step": len(self.trace) + 1, "query": name, "cypher": Q[name].strip(), "params": params,
                           "rows": len(rows), "ms": round((time.perf_counter() - t0) * 1000, 2)})
        return rows

    def scene(self, **kw) -> dict:
        kw.setdefault("queries", [t["step"] for t in self.trace[self._shown:]])
        self._shown = len(self.trace)
        s = SceneState(seq=len(self.scenes) + 1, **kw).model_dump()
        self.scenes.append(s)
        return {"event": "step", "data": {"scene": s, "trace": self.trace[-1] if self.trace else None}}

    def run(self):
        """Generator of SSE-ready events. Final event is `result`."""
        open_incidents = self.q("open_incidents", {})
        intent = parse_intent(self.text, open_incidents)
        yield self.scene(phase="intent", title="Parsing request",
                         annotation=f"Incident resolved by {intent['matched_by']}" if intent["incident_id"]
                         else intent["matched_by"], particles="idle", focus=[])
        if not intent["incident_id"]:
            raise AgentError("no_incident", f"Cannot investigate: {intent['matched_by']}. "
                             f"Open incidents: {', '.join(i['id'] for i in open_incidents) or 'none'}.")

        # 1. Incident context ------------------------------------------------
        iid = intent["incident_id"]
        ctx = self.q("incident_context", {"iid": iid})
        if not ctx:
            raise AgentError("no_incident", f"{iid} not found in the graph, or it has no alerts attached.")
        incident = ctx[0]["incident"]
        alerts = {r["alert"]["id"]: {**r["alert"], "service": r["service"]["id"]} for r in ctx}
        symptoms = sorted({r["service"]["id"] for r in ctx})
        ents = [{"label": "Incident", **incident}] + [{"label": "Alert", **a} for a in alerts.values()]
        edges = [[iid, a, "TRIGGERED_BY"] for a in alerts] + [[a, v["service"], "FIRED_ON"] for a, v in alerts.items()]
        yield self.scene(phase="context", title=f"{iid} · {incident['name']}",
                         annotation=f"{len(alerts)} alerts fired on {', '.join(symptoms)}. These are symptoms, not causes.",
                         entities=ents, edges=edges, path=[[iid, a] for a in alerts] + [[a, v["service"]] for a, v in alerts.items()],
                         focus=symptoms, particles="trace")

        # 2. Dependency frontier ---------------------------------------------
        reach: dict[str, dict] = {}
        for r in self.q("dependency_frontier", {"symptoms": symptoms}):
            prev = reach.get(r["target"])
            if prev is None or _pref(r) < _pref(prev):
                reach[r["target"]] = {"hops": r["hops"], "sync": r["sync"], "path": r["path"]}
        sync_reach = sorted(k for k, v in reach.items() if v["sync"])
        frontier_path = []
        for v in sorted(reach.values(), key=lambda v: v["hops"]):
            for a, b in zip(v["path"], v["path"][1:]):
                if [a, b] not in frontier_path:
                    frontier_path.append([a, b])
        yield self.scene(phase="frontier", title="Walking dependencies from the symptoms",
                         annotation=f"{len(sync_reach)} components synchronously reachable within {MAX_HOPS} hops — "
                                    "only changes on these can block the alerting requests.",
                         path=frontier_path, focus=sync_reach, particles="trace")

        # 3. Candidate changes in the window ---------------------------------
        cand_rows = self.q("candidate_changes", {"from": incident["ts"] - WINDOW_BEFORE, "to": incident["ts"] + WINDOW_AFTER,
                                                 "env": incident.get("env", "prod")})
        cands = {}
        for r in cand_rows:
            c = r["change"]
            cands[c["id"]] = {"id": c["id"], "label": [l for l in r["labels"] if l != "Change"][0], "name": c["name"],
                              "ts": c["ts"], "at": c["at"], "service": r["service"], "service_name": r["service_name"],
                              "props": c, "reach": reach.get(r["service"])}
        cids = list(cands)
        yield self.scene(phase="candidates", title=f"{len(cids)} changes in the window",
                         annotation="Deployments and runtime config changes from 6 h before to 1 h after the start.",
                         entities=[{"label": c["label"], **c["props"]} for c in cands.values()],
                         edges=[[c["id"], c["service"], "DEPLOYED_TO" if c["label"] == "Deployment" else "APPLIED_TO"]
                                for c in cands.values()],
                         focus=cids, particles="trace")
        if not cids:
            raise AgentError("insufficient_evidence", f"No recorded changes between {iso(incident['ts'] - WINDOW_BEFORE)} "
                             f"and {iso(incident['ts'] + WINDOW_AFTER)}. DevRoot will not guess a cause.", 200)

        # 4. Contents, mechanisms, scoped signals ----------------------------
        contents = self.q("change_contents", {"cids": cids})
        touched = self.q("touched_mechanisms", {"cids": cids})
        signals = self.q("scoped_signals", {"cids": cids, "until": incident["ts"] + SIGNAL_GRACE})
        for c in cands.values():
            c["contents"], seen = [], set()
            for r in contents:
                if r["cid"] != c["id"]:
                    continue
                el = r["element"]
                if el["id"] not in seen:
                    seen.add(el["id"])
                    c["contents"].append({"id": el["id"], "rel": r["rel"], "name": el["name"], "author": r["author"],
                                          "modules": [], "tests": []})
                item = next(i for i in c["contents"] if i["id"] == el["id"])
                if r["module"] and r["module"]["path"] not in item["modules"]:
                    item["modules"].append(r["module"]["path"])
                if r["test"] and all(t["id"] != r["test"]["id"] for t in item["tests"]):
                    item["tests"].append({k: r["test"][k] for k in ("id", "name", "status")})
            c["touches"] = sorted({(r["via"], r["fm"], r["fm_name"]) for r in touched if r["cid"] == c["id"]})
            fm_set = {fm for _, fm, _ in c["touches"]}
            c["signals"] = []
            for r in sorted((r for r in signals if r["cid"] == c["id"]), key=lambda r: (r["signal"]["ts"], r["signal"]["id"])):
                s = r["signal"]
                kind = "metric" if "MetricSignal" in r["labels"] else "log"
                c["signals"].append({"id": s["id"], "kind": kind, "service": r["service"], "fm": r["fm"], "ts": s["ts"],
                                     "at": s["at"], "name": s["name"], "props": s, "matches": r["fm"] in fm_set})
        sig_ents, sig_edges, ev_path = {}, [], []
        for c in cands.values():
            for s in c["signals"]:
                sig_ents[s["id"]] = {"label": "MetricSignal" if s["kind"] == "metric" else "LogEvent", **s["props"]}
                sig_edges.append([s["id"], s["service"], "OBSERVED_IN"])
                if s["matches"]:  # walk real edges: signal -INDICATES-> fm <-TOUCHES- element <-SHIPS- change
                    for via, fm, _ in c["touches"]:
                        if fm == s["fm"]:
                            for e in ([s["id"], fm], [fm, via], [via, c["id"]]):
                                if e[0] != e[1] and e not in ev_path:
                                    ev_path.append(e)
        fm_ids = sorted({fm for c in cands.values() for _, fm, _ in c["touches"]} |
                        {s["fm"] for c in cands.values() for s in c["signals"] if s["fm"]})
        fm_ents = [{"label": "FailureMode", "id": fm, "name": next((n for c in cands.values() for _, f, n in c["touches"] if f == fm), fm)}
                   for fm in fm_ids]
        via_ents = {r["via"]: {"label": r["via_label"], "id": r["via"], "name": r["via_name"]}
                    for r in touched if r["via"] != r["cid"]}
        mech_edges = [[r["cid"], r["via"], "SHIPS"] for r in touched if r["via"] != r["cid"]]
        mech_edges += [[via, fm, "TOUCHES"] for c in cands.values() for via, fm, _ in c["touches"]]
        mech_edges += [[s["id"], s["fm"], "INDICATES"] for c in cands.values() for s in c["signals"] if s["fm"]]
        yield self.scene(phase="evidence", title="Joining changes to observed mechanisms",
                         annotation="(change)-[:TOUCHES]->(FailureMode)<-[:INDICATES]-(signal): "
                                    f"{sum(1 for c in cands.values() for s in c['signals'] if s['matches'])} signal matches.",
                         entities=list(sig_ents.values()) + list(via_ents.values()) + fm_ents, edges=sig_edges + mech_edges,
                         path=ev_path,
                         focus=[c["id"] for c in cands.values() if any(s["matches"] for s in c["signals"])], particles="converge")

        # 5. History & documented mechanisms ---------------------------------
        hist_rows = self.q("mechanism_history", {"fms": fm_ids}) if fm_ids else []
        mech = {r["fm"]: {"name": r["name"], "runbooks": [x for x in r["runbooks"] if x],
                          "incidents": [x for x in r["incidents"] if x]} for r in hist_rows}
        h_ents, h_edges = [], []
        for fm, m in mech.items():
            for p in m["incidents"]:
                h_ents.append({"label": "Incident", **p}); h_edges.append([p["id"], fm, "EXHIBITED"])
            for rb in m["runbooks"]:
                h_ents.append({"label": "Runbook", **rb}); h_edges.append([rb["id"], fm, "MITIGATES"])
        yield self.scene(phase="history", title="Checking incident history",
                         annotation=f"{sum(len(m['incidents']) for m in mech.values())} resolved incidents share a mechanism; "
                                    f"{sum(len(m['runbooks']) for m in mech.values())} runbooks document them.",
                         entities=h_ents, edges=h_edges, path=[[a, b] for a, b, _ in h_edges], particles="converge",
                         focus=[e["id"] for e in h_ents])

        # 6. Rank ------------------------------------------------------------
        for c in cands.values():
            matched = [s for s in c["signals"] if s["matches"]]
            mfms = {s["fm"] for s in matched}
            documented = any(mech.get(fm, {}).get("runbooks") for fm in mfms)
            history = any(mech.get(fm, {}).get("incidents") for fm in mfms)
            c.update(score_candidate(c["ts"], incident["ts"], c["reach"], matched, documented, history))
            c["explains_symptom"] = bool(c["reach"] and c["reach"]["sync"])
            self._explain(c, incident, symptoms, mech, matched)
        ranked = sorted(cands.values(), key=lambda c: (-c["score"], c["ts"], c["id"]))
        for i, c in enumerate(ranked, 1):
            c["rank"] = i
        top = ranked[0]
        supported = top["score"] >= 60 and top["explains_symptom"] and any(s["matches"] for s in top["signals"])
        status = "supported" if supported else "insufficient"
        top_path = []
        if top["reach"]:
            p = top["reach"]["path"] + [top["id"]]
            top_path = [[a, b] for a, b in zip(p, p[1:])]
        yield self.scene(phase="ranking", title=f"Leading hypothesis: {top['id']} ({top['score']}/100)",
                         annotation=f"{top['name']} on {top['service_name']}. Heuristic evidence score, not a probability.",
                         path=top_path, focus=[top["id"]], particles="converge", evidence_status=status,
                         hypothesis={"id": top["id"], "score": top["score"], "status": "hypothesis"})

        # 7. Evidence chain for the top candidate (one Cypher proof query) ---
        chain = self.q("evidence_chain", {"iid": iid, "cid": top["id"]})
        for r in chain:
            r["signals"] = sorted(r["signals"])
        chain.sort(key=lambda r: (r["hops"], r["alert"], r["element"], r["fm"]))

        # 8. Blast radius + ownership ----------------------------------------
        blast = blast_radius(self, top["service"])
        crit = {r["id"]: r["score"] for r in self.q("betweenness", {})}
        for b in blast["services"]:
            b["betweenness"] = crit.get(b["id"], 0)
        blast["origin_betweenness"] = crit.get(top["service"], 0)
        choke = max(blast["services"], key=lambda b: b["betweenness"], default=None)
        owner = self.q("ownership", {"sid": top["service"]})
        top["owners"] = owner[0] if owner else None
        yield self.scene(phase="blast", title=f"Blast radius of {top['service_name']}",
                         annotation=f"{len(blast['services'])} services depend on it "
                                    f"({sum(1 for s in blast['services'] if s['impact'] == 'direct')} directly). "
                                    + (f"Biggest chokepoint exposed: {choke['name']} (betweenness {choke['betweenness']:g}). "
                                       if choke and choke["betweenness"] else "")
                                    + "Reachability ≠ confirmed outage.",
                         path=blast["edges"], focus=[s["id"] for s in blast["services"]], particles="blast",
                         hypothesis={"id": top["id"], "score": top["score"], "status": "hypothesis"}, evidence_status=status)

        result = self._result(intent, incident, alerts, symptoms, ranked, chain, blast, mech, status)
        yield self.scene(phase="complete", title="Investigation complete",
                         annotation=result["narrative"], path=top_path + [[e[0], e[1]] for e in _chain_edges(chain)],
                         focus=[top["id"]], particles="converge", evidence_status=status,
                         hypothesis={"id": top["id"], "score": top["score"], "status": "hypothesis"})
        result["scenes"], result["trace"] = self.scenes, self.trace
        self._persist(result)
        yield {"event": "result", "data": result}

    def _explain(self, c, incident, symptoms, mech, matched):
        sup, con, unk = [], [], []
        dt = incident["ts"] - c["ts"]
        if dt >= 0:
            sup.append(f"Applied {_mins(dt)} min before the incident started ({c['at']}).")
        else:
            con.append(f"Applied {_mins(dt)} min AFTER the incident started ({c['at']}); cannot have caused its onset.")
        r = c["reach"]
        if r is None:
            con.append(f"No DEPENDS_ON path from {', '.join(symptoms)} to {c['service']}: cannot explain the alerting "
                       "symptom unless the recorded topology is incomplete.")
        elif not r["sync"]:
            con.append(f"{c['service']} is reachable only through async (queued) dependencies; that delays work, "
                       "it does not block synchronous requests.")
        else:
            sup.append(f"Synchronously reachable from the symptom: {' → '.join(r['path'])} ({r['hops']} hop(s)).")
        for s in matched:
            sup.append(f"[{s['id']}] {s['name']} on {s['service']} at {s['at']} INDICATES {s['fm']}, which this change TOUCHES.")
        if not matched:
            con.append(f"No signal on {c['service']} or its direct dependencies after the change indicates a mechanism it touches.")
        ruled_out = []
        for s in c["signals"]:
            if not s["fm"]:
                p = s["props"]
                ruled_out.append(f"[{s['id']}] {s['name']} on {s['service']}: {p.get('observed')} vs baseline "
                                 f"{p.get('baseline')} {p.get('unit', '')} — no anomaly recorded.")
        for fm in sorted({s["fm"] for s in matched}):
            for p in mech.get(fm, {}).get("incidents", []):
                sup.append(f"[{p['id']}] {p['name']} ({p['at']}) exhibited the same mechanism; resolution: {p['resolution']}")
        elements = [via for via, _, _ in c["touches"]]
        if len(elements) > 1:
            unk.append(f"{c['id']} touches mechanisms through {', '.join(elements)}; the graph cannot separate their "
                       "individual contributions.")
        for item in c.get("contents", []):
            for t in item["tests"]:
                if t["status"] != "passed":
                    unk.append(f"[{t['id']}] {t['name']} covering {', '.join(item['modules'])} was {t['status']} "
                               "before this change shipped — unverified under load.")
                elif not matched:
                    con.append(f"[{t['id']}] {t['name']} covering the changed code passed.")
        unk.append("No request-volume or traffic data in the graph; score is a heuristic over recorded evidence only.")
        runbooks = [rb for fm in sorted({s["fm"] for s in matched}) for rb in mech.get(fm, {}).get("runbooks", [])]
        if runbooks:
            rb = runbooks[0]
            nxt = f"Verify against {rb['id']} '{rb['name']}': {rb['steps'][0]}."
        elif matched:
            nxt = f"Inspect {c['id']} diff on {c['service']}; no runbook documents this mechanism."
        else:
            nxt = f"Low priority: collect telemetry on {c['service']} only if stronger hypotheses are ruled out."
        c.update(supporting=sup, contradicting=con, ruled_out=ruled_out, unknowns=unk, next_step=nxt)

    def _result(self, intent, incident, alerts, symptoms, ranked, chain, blast, mech, status):
        top = ranked[0]
        ledger = []
        for a in alerts.values():
            ledger.append({"id": a["id"], "kind": "alert", "ts": a["ts"], "at": a["at"], "service": a["service"],
                           "relation": f"{incident['id']} -TRIGGERED_BY-> {a['id']} -FIRED_ON-> {a['service']}",
                           "detail": f"{a['name']} ({a['severity']})", "stance": "symptom", "source": a["source"]})
        seen = set()
        for c in ranked:
            for s in c["signals"]:
                if s["id"] in seen:
                    continue
                seen.add(s["id"])
                p = s["props"]
                stance = ("supports" if s["matches"] and c["id"] == top["id"] else
                          "supports-other" if s["matches"] else "context")
                detail = p.get("message") or f"{p.get('observed')} {p.get('unit', '')} (baseline {p.get('baseline')})"
                ledger.append({"id": s["id"], "kind": s["kind"], "ts": s["ts"], "at": s["at"], "service": s["service"],
                               "relation": f"{s['id']} -OBSERVED_IN-> {s['service']}" + (f" ; -INDICATES-> {s['fm']}" if s["fm"] else ""),
                               "detail": f"{s['name']}: {detail}", "stance": stance, "hypothesis": c["id"] if s["matches"] else None,
                               "source": p.get("source")})
            ledger.append({"id": c["id"], "kind": "change", "ts": c["ts"], "at": c["at"], "service": c["service"],
                           "relation": f"{c['id']} -{'DEPLOYED_TO' if c['label'] == 'Deployment' else 'APPLIED_TO'}-> {c['service']}",
                           "detail": c["name"], "stance": "hypothesis" if c["id"] == top["id"] else "candidate",
                           "source": c["props"].get("source")})
        ledger.sort(key=lambda e: (e["ts"], e["id"]))
        matched_ids = [s["id"] for s in top["signals"] if s["matches"]]
        narrative = (
            f"{incident['id']} surfaced on {', '.join(symptoms)}, but the strongest connected evidence points to "
            f"{top['id']} ({top['name']}) on {top['service_name']}, scored {top['score']}/100 (heuristic). "
            + (f"It is synchronously reachable via {' → '.join(top['reach']['path'])}; " if top["explains_symptom"] else
               "It has NO synchronous path to the symptom; ")
            + (f"signals {', '.join(matched_ids)} indicate mechanisms it touches. " if matched_ids else "no signal matches its mechanism. ")
            + (f"Runner-up {ranked[1]['id']} scored {ranked[1]['score']}. " if len(ranked) > 1 else "")
            + ("Status: hypothesis supported by graph evidence, not verified." if status == "supported"
               else "Status: insufficient evidence for a confident diagnosis.")
        )
        for c in ranked:
            c.pop("props", None)
        return {"investigation_id": self.id, "intent": intent, "incident": incident, "alerts": list(alerts.values()),
                "symptoms": symptoms, "candidates": ranked, "top": top["id"], "evidence_status": status,
                "evidence_chain": chain, "blast_radius": blast, "mechanisms": mech, "evidence": ledger,
                "narrative": narrative, "prior_investigations": self.q("prior_investigations", {"iid": incident["id"]}),
                "llm_used": False}

    def _persist(self, result):
        self.g.query(Q_WRITE_INVESTIGATION, {
            "iid": result["incident"]["id"], "id": self.id, "name": f"Investigation of {result['incident']['id']}",
            "ts": int(time.time()), "query": self.text, "top": result["top"],
            "score": result["candidates"][0]["score"], "record": json.dumps(result, default=str),
            "hyps": [{"id": c["id"], "rank": c["rank"], "score": c["score"]} for c in result["candidates"]],
        })


def _pref(r):
    """Prefer sync paths, then fewer hops, then lexicographic path — deterministic regardless of row order."""
    return (not r["sync"], r["hops"], r["path"])


def _chain_edges(chain):
    out = []
    for r in chain[:2]:
        out += [[r["alert"], r["path"][0], "FIRED_ON"]]
        out += [[a, b, "DEPENDS_ON"] for a, b in zip(r["path"], r["path"][1:])]
        out += [[r["path"][-1], r["element"], "SHIPS"], [r["element"], r["fm"], "TOUCHES"]]
        out += [[s, r["fm"], "INDICATES"] for s in r["signals"]]
    return out


def blast_radius(inv_or_graph, sid: str) -> dict:
    run = inv_or_graph.q if isinstance(inv_or_graph, Investigation) else (
        lambda name, p: _rows(inv_or_graph.ro_query(Q[name], p, timeout=5000)))
    best: dict[str, dict] = {}
    for r in run("blast_radius", {"sid": sid}):
        prev = best.get(r["service"])
        if prev is None or _pref(r) < _pref(prev):
            best[r["service"]] = r
    services, edges = [], []
    for r in sorted(best.values(), key=lambda r: (r["hops"], r["service"])):
        impact = ("direct" if r["hops"] == 1 else "transitive") if r["sync"] else "buffered (uncertain)"
        services.append({"id": r["service"], "name": r["name"], "kind": r["kind"], "hops": r["hops"],
                         "path": r["path"], "impact": impact})
        # paths run dependent → ... → sid; propagate visually from sid outward
        for a, b in reversed(list(zip(r["path"], r["path"][1:]))):
            if [b, a] not in edges:
                edges.append([b, a])
    return {"origin": sid, "services": services, "edges": edges}


def rollback_preview(g, cid: str) -> dict:
    """Scenario comparison only. Nothing is executed."""
    rows = _rows(g.ro_query("""
MATCH (c:Change {id: $cid})-[:DEPLOYED_TO|APPLIED_TO]->(s:Service)
OPTIONAL MATCH (c)-[:SHIPS|INCLUDES]->(x)
OPTIONAL MATCH (x)-[:MODIFIES]->(m:CodeModule)
OPTIONAL MATCH (t:Test)-[:COVERS]->(m)
OPTIONAL MATCH (c)-[:SHIPS|INCLUDES*0..1]->(x2)-[:TOUCHES]->(fm:FailureMode)<-[:INDICATES]-(sig:Signal)
WHERE sig.ts >= c.ts
RETURN properties(c) AS change, s.id AS service, s.name AS service_name, collect(DISTINCT properties(x)) AS reverts,
       collect(DISTINCT m.path) AS modules, collect(DISTINCT properties(t)) AS tests,
       collect(DISTINCT sig.id) AS should_clear, collect(DISTINCT fm.id) AS mechanisms""", {"cid": cid}, timeout=5000))
    if not rows:
        raise AgentError("not_found", f"Change {cid} not found.")
    r = rows[0]
    br = blast_radius(g, r["service"])
    reverts = sorted([x for x in r["reverts"] if x], key=lambda x: x["id"])
    return {
        "executed": False, "kind": "scenario preview", "change": r["change"], "service": r["service"],
        "reverts": [{"id": x["id"], "name": x["name"],
                     "restores": f"{x['key']} = {x['old_value']}" if "old_value" in x else None} for x in reverts],
        "modules": sorted(m for m in r["modules"] if m),
        "restart_affects": br["services"],
        "signals_to_recheck": sorted(r["should_clear"]),
        "mechanisms": sorted(r["mechanisms"]),
        "validation": [f"[{t['id']}] {t['name']}: currently {t['status']}" for t in sorted((t for t in r["tests"] if t), key=lambda t: t["id"])],
        "unknowns": [
            f"Rolling back {cid} also reverts {len(reverts)} item(s); collateral changes: " +
            ", ".join(x["id"] for x in reverts if "old_value" not in x) if reverts else "No recorded contents.",
            "DevRoot has no model of recovery time or probability; re-check the listed signals after rollback.",
            "A restart of the service briefly affects every listed dependent.",
        ],
    }


def criticality(g) -> list[dict]:
    """Graph algorithms as tools: betweenness (chokepoints) and PageRank (dependency weight) over DEPENDS_ON."""
    bt = {r["id"]: r["score"] for r in _rows(g.ro_query(Q["betweenness"], timeout=5000))}
    pr = {r["id"]: r["score"] for r in _rows(g.ro_query(Q["pagerank"], timeout=5000))}
    return sorted(({"id": k, "betweenness": bt[k], "pagerank": round(pr.get(k, 0), 4)} for k in bt),
                  key=lambda r: (-r["betweenness"], -r["pagerank"], r["id"]))


# ---------------------------------------------------------------- actions (human-approved, recorded in the graph)
Q_ACTION_TARGETS = """
MATCH (v:Investigation {id: $vid})-[:HYPOTHESIZED {rank: 1}]->(c:Change)-[:DEPLOYED_TO|APPLIED_TO]->(s:Service)
OPTIONAL MATCH (s)-[:OWNED_BY]->(t:Team)<-[:MEMBER_OF]-(e:Engineer)
OPTIONAL MATCH (c)-[:SHIPS|INCLUDES*0..1]->(x)-[:AUTHORED_BY|CHANGED_BY]->(a:Engineer)
RETURN v.record AS record, c.id AS change, c.name AS change_name, s.id AS service, s.name AS service_name,
       collect(DISTINCT e.id) AS owners, collect(DISTINCT a.id) AS authors"""

Q_RECORD_ACTION = """
MATCH (v:Investigation {id: $vid})
MERGE (a:Action {id: $id})
ON CREATE SET a.type = $type, a.name = $name, a.ts = $ts, a.status = 'recorded', a.actor = 'devroot-agent',
              a.approved_by = 'operator', a.detail = $detail, a.source = 'devroot/action'
MERGE (a)-[:FOR_INVESTIGATION]->(v)
WITH a UNWIND $targets AS tid
MATCH (n {id: tid}) WHERE n:Service OR n:Engineer OR n:Change
MERGE (a)-[:TARGETS]->(n)
RETURN a.id AS id, a.status AS status, count(n) AS targets"""


def plan_actions(g, vid: str) -> dict:
    """Propose actions whose targets are derived from graph queries. Nothing is written here."""
    rows = _rows(g.ro_query(Q_ACTION_TARGETS, {"vid": vid}, timeout=5000))
    if not rows:
        raise AgentError("not_found", f"No investigation {vid} with a ranked hypothesis.")
    r = rows[0]
    status = json.loads(r["record"]).get("evidence_status")
    br = blast_radius(g, r["service"])
    sync_deps = [s["id"] for s in br["services"] if s["impact"] != "buffered (uncertain)"]
    recorded = {x["type"]: x for x in _rows(g.ro_query(
        "MATCH (a:Action)-[:FOR_INVESTIGATION]->(:Investigation {id: $vid}) RETURN a.type AS type, a.id AS id, a.status AS status",
        {"vid": vid}))}
    actions = [{
        "type": "page_owner", "name": f"Page owners of {r['service_name']} and the change author",
        "rationale": f"{r['change']} is the leading hypothesis; owners via (Service)-[:OWNED_BY]->(Team)<-[:MEMBER_OF]-(Engineer), "
                     "author via [:AUTHORED_BY|CHANGED_BY].",
        "targets": sorted(set(r["owners"]) | set(r["authors"])),
    }]
    if status == "supported":
        actions += [{
            "type": "freeze_deploys", "name": f"Freeze deploys on {r['service_name']} and its {len(sync_deps)} synchronous dependents",
            "rationale": "Targets = cause service + services reaching it via sync DEPENDS_ON*1..4 (blast radius). "
                         "Avoids stacking new changes on an unstable path.",
            "targets": [r["service"], *sync_deps],
        }, {
            "type": "rollback_request", "name": f"Open a rollback change request for {r['change']}",
            "rationale": "Records a pending change request (reverts listed in the rollback preview). It does NOT roll anything back.",
            "targets": [r["change"]],
        }]
    for a in actions:
        a["recorded"] = recorded.get(a["type"])
    return {"investigation_id": vid, "evidence_status": status, "hypothesis": r["change"], "actions": actions,
            "note": "Recorded actions are written to DevRoot's graph only; no external pager or CI system is integrated."}


def record_action(g, vid: str, typ: str) -> dict:
    plan = plan_actions(g, vid)  # re-derive targets at execution time
    a = next((x for x in plan["actions"] if x["type"] == typ), None)
    if a is None:
        raise AgentError("action_unavailable", f"Action {typ} is not available for {vid} "
                         f"(evidence status: {plan['evidence_status']}).", 409)
    rows = _rows(g.query(Q_RECORD_ACTION, {"vid": vid, "id": f"ACT-{vid[4:]}-{typ}", "type": typ, "name": a["name"],
                                           "ts": int(time.time()), "detail": a["rationale"], "targets": a["targets"]}))
    return {**rows[0], "type": typ, "name": a["name"], "target_ids": a["targets"]}


def frozen_services(g) -> list[str]:
    return [r[0] for r in g.ro_query("MATCH (a:Action {type: 'freeze_deploys', status: 'recorded'})-[:TARGETS]->(s:Service) "
                                     "RETURN DISTINCT s.id ORDER BY s.id").result_set]


def lift_freezes(g) -> int:
    return g.query("MATCH (a:Action {type: 'freeze_deploys', status: 'recorded'}) SET a.status = 'lifted' "
                   "RETURN count(a)").result_set[0][0]


# ---------------------------------------------------------------- fire drill (inject a fresh incident, rediscover it)
DRILL_SOURCE = "synthetic/drill"
DRILL_MECHANISMS = {
    "fm-pool-exhaustion": ("client.pool.max_size", "40", "4", "PoolTimeout acquiring connection", "pool.wait_ms p99", "3", "2100"),
    "fm-retry-storm": ("client.retry.max_attempts", "2", "8", "Retrying downstream call", "outbound.requests_per_s", "300", "1400"),
}


def inject_drill(g, sid: str, mechanism: str) -> dict:
    """Write a new synthetic incident into the graph. The symptom service is chosen by query (nearest sync caller)."""
    if mechanism not in DRILL_MECHANISMS:
        raise AgentError("invalid_mechanism", f"mechanism must be one of {sorted(DRILL_MECHANISMS)}", 422)
    svc = _rows(g.ro_query("MATCH (s:Service {id: $sid}) RETURN s.name AS name, s.kind AS kind", {"sid": sid}))
    if not svc or svc[0]["kind"] != "service":
        raise AgentError("invalid_service", f"{sid} is not an internal service DevRoot can deploy to.", 422)
    caller = _rows(g.ro_query("""
MATCH p = (u:Service)-[:DEPENDS_ON*1..2]->(s:Service {id: $sid})
WHERE all(r IN relationships(p) WHERE r.mode = 'sync')
RETURN u.id AS id, u.name AS name, length(p) AS hops ORDER BY hops, id LIMIT 1""", {"sid": sid}))
    if not caller:
        raise AgentError("no_symptom_path", f"Nothing calls {sid} synchronously, so a failure there cannot surface as a "
                         "user-facing symptom elsewhere. Pick another service.", 422)
    u = caller[0]
    decoy = _rows(g.ro_query("""
MATCH (u:Service {id: $uid}), (d:Service {kind: 'service'})
WHERE d <> u AND NOT (u)-[:DEPENDS_ON*1..4]->(d)
RETURN d.id AS id ORDER BY id LIMIT 1""", {"uid": u["id"]}))
    n = g.ro_query("MATCH (i:Incident {source: $src}) RETURN count(i)", {"src": DRILL_SOURCE}).result_set[0][0] + 1
    base = t("09:00", "2026-10-19") + (n - 1) * 86400  # one drill per synthetic day: windows never overlap
    key, old, new, log_name, metric, baseline, observed = DRILL_MECHANISMS[mechanism]
    ids = {"dep": f"DEP-D{n}", "cfg": f"CFG-D{n}", "decoy": f"CFG-D{n}X", "inc": f"INC-{9000 + n}", "alert": f"ALR-D{n}"}
    params = {
        "src": DRILL_SOURCE, "sid": sid, "uid": u["id"], "fm": mechanism, **ids,
        "dep_name": f"{svc[0]['name']} drill release", "dep_ts": base + 40 * 60, "dep_at": iso(base + 40 * 60),
        "cfg_name": f"{key} {old} → {new}", "key": key, "old": old, "new": new,
        "m1": f"MET-D{n}", "m1_name": metric, "baseline": baseline, "observed": observed, "m1_ts": base + 45 * 60,
        "l1": f"LOG-D{n}", "l1_name": log_name, "l1_ts": base + 47 * 60,
        "l2": f"LOG-D{n}U", "l2_ts": base + 54 * 60, "a_ts": base + 55 * 60,
        "inc_name": f"{u['name']} latency spike (fire drill)",
    }
    g.query("""
MATCH (s:Service {id: $sid}), (u:Service {id: $uid}), (fm:FailureMode {id: $fm}), (up:FailureMode {id: 'fm-upstream-timeout'})
CREATE (d:Deployment:Change {id: $dep, name: $dep_name, version: 'drill', env: 'prod', status: 'succeeded', ts: $dep_ts, at: $dep_at, source: $src})
CREATE (c:ConfigChange {id: $cfg, name: $cfg_name, key: $key, old_value: $old, new_value: $new, env: 'prod', ts: $dep_ts, at: $dep_at, source: $src})
CREATE (d)-[:DEPLOYED_TO]->(s), (d)-[:SHIPS]->(c), (c)-[:APPLIED_TO]->(s), (c)-[:TOUCHES]->(fm)
CREATE (m:MetricSignal:Signal {id: $m1, name: $m1_name, baseline: $baseline, observed: $observed, unit: '', env: 'prod', ts: $m1_ts, source: $src})
CREATE (l:LogEvent:Signal {id: $l1, name: $l1_name, level: 'ERROR', message: $l1_name + ' (fire drill)', env: 'prod', ts: $l1_ts, source: $src})
CREATE (lu:LogEvent:Signal {id: $l2, name: 'upstream call timed out', level: 'ERROR', message: 'call to ' + s.name + ' timed out', env: 'prod', ts: $l2_ts, source: $src})
CREATE (m)-[:OBSERVED_IN]->(s), (l)-[:OBSERVED_IN]->(s), (m)-[:INDICATES]->(fm), (l)-[:INDICATES]->(fm)
CREATE (lu)-[:OBSERVED_IN]->(u), (lu)-[:INDICATES]->(up), (lu)-[:REFERENCES]->(s)
CREATE (a:Alert {id: $alert, name: u.name + ' p99 latency > 2s', severity: 'critical', env: 'prod', ts: $a_ts, source: $src})
CREATE (i:Incident {id: $inc, name: $inc_name, status: 'open', severity: 'SEV-2', env: 'prod', ts: $a_ts, source: $src,
                    summary: 'Fire drill: injected synthetic incident.'})
CREATE (a)-[:FIRED_ON]->(u), (i)-[:TRIGGERED_BY]->(a)""", params)
    for k, v in [("m1", "m1_ts"), ("l1", "l1_ts"), ("l2", "l2_ts")]:
        g.query("MATCH (n:Signal {id: $id}) SET n.at = $at", {"id": params[k], "at": iso(params[v])})
    g.query("MATCH (n) WHERE n.id IN [$a, $i] SET n.at = $at", {"a": ids["alert"], "i": ids["inc"], "at": iso(params["a_ts"])})
    if decoy:  # a closer-in-time change on a service the symptom cannot reach: the agent must reject it by topology
        g.query("""MATCH (s:Service {id: $sid})
CREATE (c:ConfigChange:Change {id: $id, name: 'feature.flag.recs_v2 off → on', key: 'feature.flag.recs_v2', old_value: 'off',
        new_value: 'on', env: 'prod', ts: $ts, at: $at, source: $src})-[:APPLIED_TO]->(s)""",
                {"sid": decoy[0]["id"], "id": ids["decoy"], "ts": base + 52 * 60, "at": iso(base + 52 * 60), "src": DRILL_SOURCE})
    return {"incident_id": ids["inc"], "symptom_service": u["id"], "symptom_hops": u["hops"],
            "injected_cause": ids["dep"], "decoy": ids["decoy"] if decoy else None, "mechanism": mechanism}


def reset_drills(g) -> int:
    g.query("MATCH (v:Investigation)-[:INVESTIGATED]->(:Incident {source: $src}) "
            "OPTIONAL MATCH (a:Action)-[:FOR_INVESTIGATION]->(v) DETACH DELETE a, v", {"src": DRILL_SOURCE})
    return g.query("MATCH (n {source: $src}) DETACH DELETE n RETURN count(n)", {"src": DRILL_SOURCE}).result_set[0][0]
