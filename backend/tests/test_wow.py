"""Graph algorithms, human-approved actions, fire drills and MCP tools."""
import asyncio
import json
import os
import tempfile

os.environ.setdefault("DEVROOT_DB_PATH", os.path.join(tempfile.mkdtemp(), "test.db"))
os.environ.pop("FALKORDB_URL", None)

import pytest
from fastapi.testclient import TestClient

from devroot import agent, app as appmod, db, mcp_server, seed

DRILL_TARGETS = ["svc-auth", "svc-checkout", "svc-gateway", "svc-ledger", "svc-payment", "svc-refund"]


@pytest.fixture(scope="module")
def g():
    gr = db.graph()
    seed.load(gr)
    yield gr
    agent.reset_drills(gr)
    agent.lift_freezes(gr)


def investigate(g, q):
    return list(agent.Investigation(g, q).run())[-1]["data"]


def test_criticality_uses_graph_algorithms(g):
    crit = agent.criticality(g)
    assert crit[0]["id"] == "svc-payment"  # every checkout/refund path to the ledger runs through it
    assert agent.criticality(g) == crit    # fixed sampling seed → reproducible
    assert {c["id"] for c in crit} == {s[0] for s in seed.SERVICES}


def test_investigation_blast_step_uses_betweenness(g):
    r = investigate(g, "INC-2041")
    assert "betweenness" in [t["query"] for t in r["trace"]]
    assert all("betweenness" in s for s in r["blast_radius"]["services"])


@pytest.mark.parametrize("sid", DRILL_TARGETS)
@pytest.mark.parametrize("fm", sorted(agent.DRILL_MECHANISMS))
def test_fire_drill_is_rediscovered(g, sid, fm):
    d = agent.inject_drill(g, sid, fm)
    r = investigate(g, d["incident_id"])
    assert r["symptoms"] == [d["symptom_service"]] and d["symptom_service"] != sid
    assert r["candidates"][0]["id"] == d["injected_cause"], [(c["id"], c["score"]) for c in r["candidates"]]
    assert r["evidence_status"] == "supported"
    if d["decoy"]:
        decoy = next(c for c in r["candidates"] if c["id"] == d["decoy"])
        assert not decoy["explains_symptom"] and decoy["ts"] > r["candidates"][0]["ts"]  # closer in time, still rejected


def test_drill_rejects_service_without_caller(g):
    with pytest.raises(agent.AgentError) as e:
        agent.inject_drill(g, "svc-web", "fm-pool-exhaustion")
    assert e.value.code == "no_symptom_path"
    with pytest.raises(agent.AgentError):
        agent.inject_drill(g, "db-ledger", "fm-pool-exhaustion")


def test_drill_reset_restores_seed(g):
    before = seed.counts(g)
    agent.inject_drill(g, "svc-payment", "fm-pool-exhaustion")
    assert agent.reset_drills(g) > 0
    assert seed.counts(g) == before
    assert not g.ro_query("MATCH (n {source: 'synthetic/drill'}) RETURN n").result_set


def test_actions_derived_from_graph_and_recorded(g):
    r = investigate(g, "INC-2041")
    plan = agent.plan_actions(g, r["investigation_id"])
    by = {a["type"]: a for a in plan["actions"]}
    assert set(by["page_owner"]["targets"]) == {"eng-jo", "eng-ravi"}
    assert set(by["freeze_deploys"]["targets"]) == {"svc-payment", "svc-checkout", "svc-refund", "svc-gateway", "svc-web"}
    rec = agent.record_action(g, r["investigation_id"], "freeze_deploys")
    assert rec["targets"] == 5 and agent.record_action(g, r["investigation_id"], "freeze_deploys")["id"] == rec["id"]
    assert "svc-payment" in agent.frozen_services(g)
    assert agent.lift_freezes(g) >= 1 and agent.frozen_services(g) == []


def test_insufficient_evidence_offers_no_freeze(g):
    r = investigate(g, "INC-2041")
    g.query("MATCH (v:Investigation {id: $id}) SET v.record = $rec",
            {"id": r["investigation_id"], "rec": json.dumps({"evidence_status": "insufficient"})})
    plan = agent.plan_actions(g, r["investigation_id"])
    assert [a["type"] for a in plan["actions"]] == ["page_owner"]
    with pytest.raises(agent.AgentError) as e:
        agent.record_action(g, r["investigation_id"], "freeze_deploys")
    assert e.value.status == 409


def test_action_and_drill_api_validation(g):
    c = TestClient(appmod.app)
    assert c.post("/api/actions", json={"investigation_id": "x; DROP", "type": "page_owner"}).status_code == 422
    assert c.post("/api/actions", json={"investigation_id": "INV-00000000", "type": "delete_prod"}).status_code == 422
    assert c.post("/api/actions", json={"investigation_id": "INV-00000000", "type": "page_owner"}).status_code == 404
    assert c.post("/api/drills", json={"service_id": "svc-payment", "mechanism": "fm-nope"}).status_code == 422
    r = c.post("/api/drills", json={"service_id": "svc-checkout", "mechanism": "fm-pool-exhaustion"})
    assert r.status_code == 200 and r.json()["symptom_service"] == "svc-gateway"
    assert c.delete("/api/drills").json()["deleted"] > 0
    svc = {s["id"]: s for s in c.get("/api/graph").json()["services"]}
    assert svc["svc-payment"]["betweenness"] > 0 and svc["svc-payment"]["frozen"] is False


def test_mcp_tools_call_devroot_api(g, monkeypatch):
    client = TestClient(appmod.app)

    def fake_request(method, path, body=None):
        r = client.request(method, path, json=body)
        return r.text if r.status_code < 400 else json.dumps({"error": r.status_code, "detail": r.json().get("detail")})
    monkeypatch.setattr(mcp_server, "_request", fake_request)

    async def run():
        names = {t.name for t in await mcp_server.mcp.list_tools()}
        assert {"investigate", "blast_radius", "service_criticality", "plan_actions", "record_action"} <= names
        res = await mcp_server.mcp.call_tool("investigate", {"question": "Why is checkout slow? INC-2041"})
        return res
    res = asyncio.run(run())
    payload = res.structured_content or json.loads(res.content[0].text)
    payload = payload.get("result", payload)
    assert payload["candidates"][0]["id"] == "DEP-884" and "evidence_chain" in payload
    assert mcp_server.blast_radius("svc-payment")["origin"] == "svc-payment"
    assert "error" in mcp_server.get_entity("NOPE-1")
