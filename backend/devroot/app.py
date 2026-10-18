"""DevRoot HTTP API. All investigative endpoints read FalkorDB; if it is unreachable they return 503."""
import json
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import agent, db, seed

app = FastAPI(title="DevRoot", version="0.1.0")
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


def g():
    try:
        return db.graph()
    except db.GraphUnavailable as e:
        raise HTTPException(503, {"code": "graph_unavailable", "message": str(e)})


def guard(fn):
    try:
        return fn()
    except agent.AgentError as e:
        raise HTTPException(e.status, {"code": e.code, "message": e.message})
    except db.GRAPH_ERRORS as e:
        db.reset_connection()
        raise HTTPException(503, {"code": "graph_unavailable", "message": f"FalkorDB query failed: {type(e).__name__}"})


def valid_id(v: str) -> str:
    if not ID.match(v):
        raise HTTPException(422, {"code": "invalid_id", "message": "ids are 1-64 chars of [A-Za-z0-9_.-]"})
    return v


@app.on_event("startup")
def startup():
    try:
        seed.load(db.graph())
    except db.GraphUnavailable:
        pass  # endpoints will report graph_unavailable


@app.get("/api/health")
def health():
    try:
        return {"graph": "ok", **seed.counts(db.graph())}
    except (db.GraphUnavailable, *db.GRAPH_ERRORS) as e:
        db.reset_connection()
        return JSONResponse({"graph": "unavailable", "message": str(e)}, 503)


@app.get("/api/graph")
def graph_view():
    gr = g()

    def run():
        services = agent._rows(gr.ro_query(
            "MATCH (s:Service)-[:OWNED_BY]->(t:Team) OPTIONAL MATCH (a:Alert)-[:FIRED_ON]->(s) "
            "RETURN s.id AS id, s.name AS name, s.kind AS kind, t.name AS team, collect(a.severity) AS alerts ORDER BY id"))
        deps = agent._rows(gr.ro_query(
            "MATCH (a:Service)-[r:DEPENDS_ON]->(b:Service) RETURN a.id AS src, b.id AS dst, r.mode AS mode, "
            "r.protocol AS protocol ORDER BY src, dst"))
        incidents = agent._rows(gr.ro_query(
            "MATCH (i:Incident {status: 'open'}) RETURN i.id AS id, i.name AS name, i.severity AS severity, "
            "i.at AS at, i.summary AS summary ORDER BY i.ts DESC"))
        crit = {c["id"]: c for c in agent.criticality(gr)}
        frozen = set(agent.frozen_services(gr))
        for s in services:
            s["betweenness"] = crit.get(s["id"], {}).get("betweenness", 0)
            s["frozen"] = s["id"] in frozen
        return {"services": services, "dependencies": deps, "incidents": incidents}
    return guard(run)


@app.get("/api/entity/{eid}")
def entity(eid: str):
    eid, gr = valid_id(eid), g()

    def run():
        rows = agent._rows(gr.ro_query(
            "MATCH (n {id: $id}) OPTIONAL MATCH (n)-[r]-(m) WHERE NOT m:Investigation "
            "RETURN properties(n) AS node, labels(n) AS labels, "
            "collect({type: type(r), out: startNode(r) = n, id: m.id, name: m.name, label: labels(m)[0]})[0..40] AS neighbors",
            {"id": eid}, timeout=5000))
        if not rows or rows[0]["node"] is None:
            raise agent.AgentError("not_found", f"No entity {eid} in the graph.")
        r = rows[0]
        return {"node": r["node"], "labels": r["labels"], "neighbors": [n for n in r["neighbors"] if n["id"]]}
    return guard(run)


@app.get("/api/investigate")
def investigate(q: str = Query("", max_length=500)):
    """Server-sent events: one `step` per query (scene state + Cypher trace), then `result` or `error`."""
    gr = g()

    def stream():
        try:
            for ev in agent.Investigation(gr, q).run():
                yield f"event: {ev['event']}\ndata: {json.dumps(ev['data'], default=str)}\n\n"
        except agent.AgentError as e:
            yield f"event: error\ndata: {json.dumps({'code': e.code, 'message': e.message})}\n\n"
        except db.GRAPH_ERRORS as e:
            db.reset_connection()
            yield f"event: error\ndata: {json.dumps({'code': 'graph_unavailable', 'message': type(e).__name__})}\n\n"
    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.get("/api/blast-radius/{sid}")
def blast(sid: str):
    sid, gr = valid_id(sid), g()
    return guard(lambda: agent.blast_radius(gr, sid))


@app.get("/api/rollback-preview/{cid}")
def rollback(cid: str):
    cid, gr = valid_id(cid), g()
    return guard(lambda: agent.rollback_preview(gr, cid))


@app.get("/api/schema")
def schema():
    """What FalkorDB holds right now: engine version, connection mode, label and relationship counts."""
    gr = g()

    def run():
        labels = agent._rows(gr.ro_query("MATCH (n) RETURN labels(n)[0] AS label, count(n) AS n ORDER BY n DESC, label"))
        rels = agent._rows(gr.ro_query("MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS n ORDER BY n DESC, type"))
        try:
            ver = next(m["ver"] for m in gr.execute_command("MODULE", "LIST") if m["name"] == "graph")
            version = f"{ver // 10000}.{ver // 100 % 100}.{ver % 100}"
        except Exception:
            version = None
        import os
        return {"graph": gr.name, "version": version, "labels": labels, "relationships": rels,
                "mode": "FalkorDB server (FALKORDB_URL)" if os.environ.get("FALKORDB_URL") else "embedded FalkorDB (falkordblite)"}
    return guard(run)


@app.get("/api/criticality")
def criticality():
    """FalkorDB graph algorithms: algo.betweenness (sampled, fixed seed) + algo.pageRank over DEPENDS_ON."""
    gr = g()
    return guard(lambda: agent.criticality(gr))


class ActionIn(BaseModel):
    investigation_id: str = Field(pattern=r"^INV-[0-9a-f]{8}$")
    type: str = Field(pattern=r"^(page_owner|freeze_deploys|rollback_request)$")


@app.get("/api/actions/plan/{vid}")
def action_plan(vid: str):
    vid, gr = valid_id(vid), g()
    return guard(lambda: agent.plan_actions(gr, vid))


@app.post("/api/actions")
def action_record(body: ActionIn):
    """Human-approved: the operator clicked approve. Writes (:Action)-[:TARGETS]->(...) into the graph."""
    gr = g()
    return guard(lambda: agent.record_action(gr, body.investigation_id, body.type))


@app.get("/api/actions")
def action_list():
    gr = g()
    return guard(lambda: agent._rows(gr.ro_query(
        "MATCH (a:Action) OPTIONAL MATCH (a)-[:TARGETS]->(n) RETURN a.id AS id, a.type AS type, a.name AS name, "
        "a.status AS status, a.ts AS ts, collect(n.id) AS targets ORDER BY ts DESC LIMIT 50")))


@app.post("/api/actions/lift-freezes")
def action_lift():
    gr = g()
    return guard(lambda: {"lifted": agent.lift_freezes(gr)})


class DrillIn(BaseModel):
    service_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
    mechanism: str = Field(pattern=r"^fm-[a-z-]{1,40}$")


@app.post("/api/drills")
def drill(body: DrillIn):
    gr = g()
    return guard(lambda: agent.inject_drill(gr, body.service_id, body.mechanism))


@app.delete("/api/drills")
def drill_reset():
    gr = g()
    return guard(lambda: {"deleted": agent.reset_drills(gr)})


@app.get("/api/investigations")
def investigations(incident: str = "INC-2041"):
    incident, gr = valid_id(incident), g()
    return guard(lambda: agent._rows(gr.ro_query(agent.Q["prior_investigations"], {"iid": incident})))


@app.get("/api/investigations/{vid}")
def investigation(vid: str):
    vid, gr = valid_id(vid), g()

    def run():
        rows = gr.ro_query("MATCH (v:Investigation {id: $id}) RETURN v.record", {"id": vid}).result_set
        if not rows:
            raise agent.AgentError("not_found", f"No investigation {vid}.")
        return json.loads(rows[0][0])
    return guard(run)


DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="ui")
