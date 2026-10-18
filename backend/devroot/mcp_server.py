"""DevRoot as MCP tools (stdio). Run: `python -m devroot.mcp_server` from backend/, with the DevRoot API running.

The tools call the DevRoot HTTP API (DEVROOT_API, default http://127.0.0.1:8000) instead of opening FalkorDB directly:
an embedded FalkorDB is per-process, so going through the API keeps a single graph and a single set of validations.
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from mcp.server.mcpserver import MCPServer

API = os.environ.get("DEVROOT_API", "http://127.0.0.1:8000")

mcp = MCPServer(
    "devroot",
    instructions="DevRoot investigates incidents over a FalkorDB graph of services, changes, signals and owners. "
                 "Start with list_incidents or investigate. Every answer cites graph ids; treat scores as heuristic. "
                 "record_action writes to DevRoot's graph only and needs the user's approval.",
)


def _request(method: str, path: str, body: dict | None = None) -> str:
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode()
    except urllib.error.HTTPError as e:
        return json.dumps({"error": e.code, "detail": json.loads(e.read() or b"{}").get("detail")})
    except urllib.error.URLError as e:
        return json.dumps({"error": "devroot_api_unreachable", "detail": str(e.reason), "api": API})


def _get(path: str) -> dict | list:
    return json.loads(_request("GET", path))


@mcp.tool()
def list_incidents() -> dict:
    """Open incidents in the graph, plus services with their chokepoint (betweenness) score and freeze status."""
    g = _get("/api/graph")
    return g if "error" in g else {"incidents": g["incidents"], "services": g["services"]}


@mcp.tool()
def investigate(question: str) -> dict:
    """Run DevRoot's bounded graph investigation (12 read-only Cypher queries) for a natural-language question or
    an incident id like INC-2041. Returns ranked candidate causes with supporting/contradicting evidence and paths."""
    raw = _request("GET", "/api/investigate?q=" + urllib.parse.quote(question[:500]))
    event = None
    for line in raw.splitlines():
        if line.startswith("event: "):
            event = line[7:]
        elif line.startswith("data: ") and event in ("result", "error"):
            d = json.loads(line[6:])
            if event == "error":
                return {"error": d["code"], "message": d["message"]}
            keep = ("id", "name", "service", "score", "terms", "explains_symptom", "supporting", "contradicting",
                    "unknowns", "next_step")
            return {"investigation_id": d["investigation_id"], "incident": d["incident"]["id"], "symptoms": d["symptoms"],
                    "evidence_status": d["evidence_status"], "narrative": d["narrative"],
                    "candidates": [{k: c.get(k) for k in keep} for c in d["candidates"]],
                    "evidence_chain": d["evidence_chain"],
                    "blast_radius": [{k: s[k] for k in ("id", "impact", "hops")} for s in d["blast_radius"]["services"]],
                    "queries_run": [t["query"] for t in d["trace"]]}
    try:
        return json.loads(raw)
    except ValueError:
        return {"error": "unexpected_response"}


@mcp.tool()
def blast_radius(service_id: str) -> dict:
    """Services that depend on service_id within 4 DEPENDS_ON hops: direct, transitive, or buffered (async)."""
    return _get("/api/blast-radius/" + urllib.parse.quote(service_id))


@mcp.tool()
def service_criticality() -> list:
    """FalkorDB algo.betweenness (sampled, fixed seed) and algo.pageRank over the service dependency graph."""
    return _get("/api/criticality")


@mcp.tool()
def rollback_preview(change_id: str) -> dict:
    """Preview (never execute) rolling back a change: reverts, restart exposure, signals to re-check, unknowns."""
    return _get("/api/rollback-preview/" + urllib.parse.quote(change_id))


@mcp.tool()
def get_entity(entity_id: str) -> dict:
    """Properties and up to 40 relationships of any graph entity (service, change, signal, alert, incident...)."""
    return _get("/api/entity/" + urllib.parse.quote(entity_id))


@mcp.tool()
def plan_actions(investigation_id: str) -> dict:
    """Actions DevRoot proposes for an investigation; targets are derived from graph queries. Writes nothing."""
    return _get("/api/actions/plan/" + urllib.parse.quote(investigation_id))


@mcp.tool()
def record_action(investigation_id: str, action_type: str) -> dict:
    """Record an approved action (page_owner | freeze_deploys | rollback_request) in DevRoot's graph.
    Does not page anyone or roll anything back in external systems."""
    return json.loads(_request("POST", "/api/actions", {"investigation_id": investigation_id, "type": action_type}))


if __name__ == "__main__":
    mcp.run("stdio")
