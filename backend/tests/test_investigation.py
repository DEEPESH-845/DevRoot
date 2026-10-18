import json
import os
import tempfile

os.environ["DEVROOT_DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ.pop("FALKORDB_URL", None)

import pytest
from fastapi.testclient import TestClient

from devroot import agent, app as appmod, db, seed

QUERY = "Investigate the payment latency spike after the latest deployment. Find the most likely root cause."


@pytest.fixture(scope="module")
def g():
    gr = db.graph()
    seed.load(gr)
    return gr


@pytest.fixture(scope="module")
def result(g):
    return run(g, QUERY)[-1]["data"]


def run(g, q):
    return list(agent.Investigation(g, q).run())


def test_seed_is_idempotent(g):
    before = seed.counts(g)
    assert seed.load(g) == before
    assert g.ro_query("MATCH (s:Service) RETURN count(s)").result_set[0][0] == len(seed.SERVICES)


def test_unique_constraint_blocks_duplicates(g):
    with pytest.raises(Exception):
        g.query("CREATE (:Service {id: 'svc-payment'})")


def test_investigation_finds_payment_change_from_graph(result):
    top = result["candidates"][0]
    assert top["id"] == "DEP-884" and top["service"] == "svc-payment"
    assert result["evidence_status"] == "supported"
    # symptom is checkout/gateway, not payment: the cause was found by traversal, not by the alert
    assert "svc-payment" not in result["symptoms"]


def test_ranking_is_deterministic(g, result):
    again = run(g, QUERY)[-1]["data"]
    strip = lambda r: [(c["id"], c["score"], c["terms"], c["supporting"], c["contradicting"]) for c in r["candidates"]]
    assert strip(again) == strip(result)


def test_unreachable_change_is_contradicted(result):
    cfg = next(c for c in result["candidates"] if c["id"] == "CFG-319")
    assert cfg["explains_symptom"] is False and cfg["terms"]["reachability"] == 0
    assert any("No DEPENDS_ON path" in x for x in cfg["contradicting"])


def test_unreachable_evidence_cannot_outvote_reachability(g):
    r = run(g, "Investigate delayed order notifications")[-1]["data"]
    assert r["intent"]["incident_id"] == "INC-2042"
    first, second = r["candidates"][:2]
    assert first["id"] == "CFG-319" and first["explains_symptom"]
    # DEP-884 has strong pool-exhaustion evidence but no path to notification-service
    dep = next(c for c in r["candidates"] if c["id"] == "DEP-884")
    assert dep["relevance"] == 0.25 and first["score"] - dep["score"] > 30


def test_change_after_onset_scores_zero_temporal(result):
    late = next(c for c in result["candidates"] if c["id"] == "DEP-886")
    assert late["terms"]["temporal"] == 0 and any("AFTER" in x for x in late["contradicting"])


def test_evidence_chain_path_from_graph(g, result):
    chain = result["evidence_chain"]
    assert chain, "evidence chain query returned no rows"
    first = chain[0]
    assert first["alert"] == "ALR-9001" and first["path"] == ["svc-checkout", "svc-payment", "DEP-884"]
    ids = {r[0] for r in g.ro_query("MATCH (n) RETURN n.id").result_set}
    for r in chain:  # every id in the answer exists in FalkorDB
        assert set(r["path"]) | {r["alert"], r["element"], r["fm"]} | set(r["signals"]) <= ids


def test_blast_radius_follows_dependencies(g):
    br = agent.blast_radius(g, "svc-payment")
    by = {s["id"]: s for s in br["services"]}
    assert set(by) == {"svc-checkout", "svc-refund", "svc-gateway", "svc-web"}
    assert by["svc-checkout"]["impact"] == "direct" and by["svc-web"]["impact"] == "transitive"
    assert "svc-notify" not in by  # consumes the queue; does not depend on payment


def test_result_carries_ids_and_trace(result):
    assert all(e["id"] and e["relation"] for e in result["evidence"])
    assert [t["query"] for t in result["trace"]][:3] == ["open_incidents", "incident_context", "dependency_frontier"]
    assert all(t["cypher"].startswith(("MATCH", "UNWIND", "CALL algo.")) for t in result["trace"])


def test_scene_states_validate(result):
    phases = [s["phase"] for s in result["scenes"]]
    assert phases[0] == "intent" and phases[-1] == "complete"
    for s in result["scenes"]:
        agent.SceneState(**s)


def test_unmatched_request_does_not_guess(g):
    with pytest.raises(agent.AgentError) as e:
        run(g, "kubernetes etcd quorum loss")
    assert e.value.code == "no_incident"


def test_unknown_incident_id(g):
    with pytest.raises(agent.AgentError):
        run(g, "investigate INC-9999")


def test_no_changes_means_insufficient(g):
    g.query("CREATE (:Incident {id:'INC-0001', name:'Old outage', status:'open', ts: 1000, at:'1970', env:'prod'})"
            "-[:TRIGGERED_BY]->(:Alert {id:'ALR-T1', name:'x', severity:'low', ts:1000, at:'1970'})"
            "-[:FIRED_ON]->(:Service {id:'svc-t1', name:'legacy', kind:'service'})")
    try:
        with pytest.raises(agent.AgentError) as e:
            run(g, "INC-0001")
        assert e.value.code == "insufficient_evidence"
    finally:
        g.query("MATCH (n) WHERE n.id IN ['INC-0001','ALR-T1','svc-t1'] DETACH DELETE n")


def test_investigation_persisted_as_hypothesis(g, result):
    rows = g.ro_query("MATCH (v:Investigation {id:$id})-[h:HYPOTHESIZED]->(c:Change) RETURN v.status, c.id, h.rank "
                      "ORDER BY h.rank", {"id": result["investigation_id"]}).result_set
    assert rows[0] == ["hypothesis", "DEP-884", 1]


def test_rollback_is_preview_only(g):
    p = agent.rollback_preview(g, "DEP-884")
    assert p["executed"] is False
    assert {"CFG-311", "CFG-312"} <= {r["id"] for r in p["reverts"]}
    assert "LOG-7710" in p["signals_to_recheck"]


def test_api_stream_and_validation(g):
    c = TestClient(appmod.app)
    body = c.get("/api/investigate", params={"q": QUERY}).text
    events = [l[7:] for l in body.splitlines() if l.startswith("event: ")]
    assert events[-1] == "result" and events.count("step") >= 8
    assert c.get("/api/entity/bad id!").status_code == 422
    assert c.get("/api/entity/DOES-NOT-EXIST").status_code == 404
    assert c.get("/api/investigate", params={"q": "x" * 600}).status_code == 422
    assert c.get("/api/graph").json()["services"]
    vid = json.loads(body.split("event: result\ndata: ")[1].split("\n")[0])["investigation_id"]
    assert c.get(f"/api/investigations/{vid}").json()["scenes"]


def test_graph_down_returns_503(monkeypatch):
    monkeypatch.setenv("FALKORDB_URL", "redis://127.0.0.1:1")
    db.reset_connection()
    try:
        c = TestClient(appmod.app)
        r = c.get("/api/investigate", params={"q": QUERY})
        assert r.status_code == 503 and r.json()["detail"]["code"] == "graph_unavailable"
        assert c.get("/api/health").status_code == 503
    finally:
        monkeypatch.delenv("FALKORDB_URL")
        db.reset_connection()
