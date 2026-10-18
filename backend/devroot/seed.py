"""Deterministic synthetic dataset for Northstar Labs (fictional company, illustrative data only).

Loading is idempotent: every node is MERGEd on a stable `id`, every edge is MERGEd between ids.
"""
from datetime import datetime, timezone

DAY = "2026-10-14"
SOURCE = "synthetic/northstar-seed-v1"


def t(hhmm: str, day: str = DAY) -> int:
    return int(datetime.fromisoformat(f"{day}T{hhmm}:00+00:00").timestamp())


def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


# (labels, props). The first label is the primary one; every node has `id` and `name`.
NODES: list[tuple[tuple[str, ...], dict]] = []
EDGES: list[tuple[str, str, str, dict]] = []  # (src_id, TYPE, dst_id, props)


def node(labels, **props):
    if "ts" in props:
        props["at"] = iso(props["ts"])
    props.setdefault("source", SOURCE)
    NODES.append((labels if isinstance(labels, tuple) else (labels,), props))
    return props["id"]


def edge(src, typ, dst, **props):
    EDGES.append((src, typ, dst, props))


# --- Organisation -----------------------------------------------------------
for tid, name in [("team-edge", "Edge Platform"), ("team-identity", "Identity"), ("team-commerce", "Commerce"),
                  ("team-payments", "Payments"), ("team-platform", "Data Platform"), ("team-engagement", "Engagement")]:
    node("Team", id=tid, name=name)

for eid, name, handle, team in [
    ("eng-ana", "Ana Ruiz", "@aruiz", "team-edge"), ("eng-tomas", "Tomás Lee", "@tlee", "team-identity"),
    ("eng-maya", "Maya Chen", "@mchen", "team-commerce"), ("eng-ravi", "Ravi Iyer", "@riyer", "team-payments"),
    ("eng-jo", "Jo Becker", "@jbecker", "team-payments"), ("eng-sam", "Sam Okafor", "@sokafor", "team-platform"),
    ("eng-lin", "Lin Park", "@lpark", "team-engagement"),
]:
    node("Engineer", id=eid, name=name, handle=handle)
    edge(eid, "MEMBER_OF", team)

# --- Services & dependencies ------------------------------------------------
SERVICES = [
    ("svc-web", "storefront-web", "service", "team-commerce"),
    ("svc-gateway", "api-gateway", "service", "team-edge"),
    ("svc-auth", "auth-service", "service", "team-identity"),
    ("svc-checkout", "checkout-service", "service", "team-commerce"),
    ("svc-refund", "refund-service", "service", "team-payments"),
    ("svc-payment", "payment-service", "service", "team-payments"),
    ("svc-ledger", "ledger-service", "service", "team-payments"),
    ("db-ledger", "ledger-postgres", "database", "team-platform"),
    ("mq-events", "events-queue", "queue", "team-platform"),
    ("svc-notify", "notification-service", "service", "team-engagement"),
    ("ext-paylane", "Paylane API", "external", "team-payments"),
]
for sid, name, kind, team in SERVICES:
    node("Service", id=sid, name=name, kind=kind, env="prod")
    edge(sid, "OWNED_BY", team)

# caller -[:DEPENDS_ON]-> callee. mode=sync: caller blocks on callee; async: buffered by a queue.
for a, b, mode, proto in [
    ("svc-web", "svc-gateway", "sync", "https"), ("svc-gateway", "svc-auth", "sync", "grpc"),
    ("svc-gateway", "svc-checkout", "sync", "grpc"), ("svc-gateway", "svc-refund", "sync", "grpc"),
    ("svc-checkout", "svc-auth", "sync", "grpc"), ("svc-checkout", "svc-payment", "sync", "grpc"),
    ("svc-checkout", "mq-events", "async", "kafka"), ("svc-refund", "svc-payment", "sync", "grpc"),
    ("svc-payment", "svc-ledger", "sync", "grpc"), ("svc-payment", "ext-paylane", "sync", "https"),
    ("svc-payment", "mq-events", "async", "kafka"), ("svc-ledger", "db-ledger", "sync", "postgres"),
    ("svc-notify", "mq-events", "async", "kafka"),
]:
    edge(a, "DEPENDS_ON", b, mode=mode, protocol=proto)

# --- Failure modes (mechanisms) and runbooks -------------------------------
node("FailureMode", id="fm-pool-exhaustion", name="connection-pool exhaustion",
     description="Callers block waiting for a pooled connection; latency rises upstream.")
node("FailureMode", id="fm-retry-storm", name="retry amplification",
     description="Aggressive retries multiply load on a struggling dependency.")
node("FailureMode", id="fm-upstream-timeout", name="upstream timeout",
     description="A caller times out waiting for a synchronous dependency.")
node("FailureMode", id="fm-consumer-lag", name="queue consumer lag",
     description="Consumers fall behind producers; async work is delayed, not failed.")

node("Runbook", id="RB-12", name="Connection pool exhaustion",
     steps=["Compare pool.max_size with peak concurrent requests per instance",
            "Check pool wait-time and in-use metrics on the calling service",
            "Restore previous pool size via config rollback; do not restart the database"])
edge("RB-12", "MITIGATES", "fm-pool-exhaustion")
node("Runbook", id="RB-15", name="Retry budget overrun",
     steps=["Inspect retry attempt counts in caller logs", "Cap retries at 2 with jittered backoff"])
edge("RB-15", "MITIGATES", "fm-retry-storm")
node("Runbook", id="RB-07", name="Event consumer backlog",
     steps=["Check consumer.concurrency and partition assignment", "Scale consumers; backlog drains without data loss"])
edge("RB-07", "MITIGATES", "fm-consumer-lag")
for rb, svc in [("RB-12", "svc-payment"), ("RB-12", "svc-refund"), ("RB-15", "svc-payment"), ("RB-07", "svc-notify")]:
    edge(rb, "DOCUMENTS", svc)

# --- Code ---------------------------------------------------------------------
for mid, path, svc in [
    ("mod-auth-jwks", "auth/jwks_cache.py", "svc-auth"), ("mod-checkout-cart", "checkout/cart_view.py", "svc-checkout"),
    ("mod-checkout-payclient", "checkout/payment_client.py", "svc-checkout"),
    ("mod-pay-ledgerclient", "payment/ledger_client.py", "svc-payment"),
    ("mod-ledger-metrics", "ledger/metrics.py", "svc-ledger"),
]:
    node("CodeModule", id=mid, name=path, path=path)
    edge(mid, "PART_OF", svc)

for tid, name, mod, status, ts in [
    ("T-auth-jwks", "test_jwks_cache_refresh", "mod-auth-jwks", "passed", t("10:05")),
    ("T-cart-render", "test_cart_promo_banner", "mod-checkout-cart", "passed", t("13:12")),
    ("T-payclient-timeout", "test_payment_client_timeout", "mod-checkout-payclient", "passed", t("13:12")),
    ("T-ledger-pool-load", "test_ledger_client_pool_under_load", "mod-pay-ledgerclient", "skipped", t("13:44")),
    ("T-ledger-retry", "test_ledger_client_retry_policy", "mod-pay-ledgerclient", "passed", t("13:44")),
]:
    node("Test", id=tid, name=name, status=status, ts=ts)
    edge(tid, "COVERS", mod)

# --- Past incidents -----------------------------------------------------------
node("Incident", id="INC-1877", name="Refund timeouts after connection pool resize", status="resolved", severity="SEV-2",
     ts=t("09:40", "2026-06-02"), resolution="Restored ledger client pool to 40; added pool saturation alert.",
     summary="refund-service p99 rose to 4s after pool max_size was lowered.")
edge("INC-1877", "EXHIBITED", "fm-pool-exhaustion")
edge("INC-1877", "RESOLVED_BY", "RB-12")
node("Incident", id="INC-1650", name="Notification backlog after consumer redeploy", status="resolved", severity="SEV-4",
     ts=t("16:10", "2026-03-19"), resolution="Raised consumer concurrency; backlog drained in 40 min.",
     summary="Push notifications delayed ~25 min; no customer-facing errors.")
edge("INC-1650", "EXHIBITED", "fm-consumer-lag")
edge("INC-1650", "RESOLVED_BY", "RB-07")

# --- Changes (2026-10-14, prod) ---------------------------------------------
# :Change = a unit of change applied to production (a deployment, or a standalone runtime config change).
node(("Deployment", "Change"), id="DEP-877", name="auth-service v3.8.2", version="v3.8.2", env="prod", ts=t("10:12"), status="succeeded")
edge("DEP-877", "DEPLOYED_TO", "svc-auth")
node("Commit", id="c-4a1e9f2", name="Rotate JWKS cache TTL to 10m", sha="4a1e9f2", ts=t("09:58"))
edge("DEP-877", "INCLUDES", "c-4a1e9f2"); edge("c-4a1e9f2", "AUTHORED_BY", "eng-tomas"); edge("c-4a1e9f2", "MODIFIES", "mod-auth-jwks")

node(("Deployment", "Change"), id="DEP-881", name="checkout-service v2.31.0", version="v2.31.0", env="prod", ts=t("13:20"), status="succeeded")
edge("DEP-881", "DEPLOYED_TO", "svc-checkout")
node("Commit", id="c-b71d03a", name="Add gift-card promo banner to cart", sha="b71d03a", ts=t("12:41"))
node("Commit", id="c-e2290c4", name="Log upstream latency histogram for payment calls", sha="e2290c4", ts=t("12:55"))
for c, m in [("c-b71d03a", "mod-checkout-cart"), ("c-e2290c4", "mod-checkout-payclient")]:
    edge("DEP-881", "INCLUDES", c); edge(c, "AUTHORED_BY", "eng-maya"); edge(c, "MODIFIES", m)

node(("Deployment", "Change"), id="DEP-884", name="payment-service v4.12.0", version="v4.12.0", env="prod", ts=t("13:52"), status="succeeded")
edge("DEP-884", "DEPLOYED_TO", "svc-payment")
node("Commit", id="c-9f03b5d", name="Reduce idle ledger connections to cut DB cost", sha="9f03b5d", ts=t("13:30"))
edge("DEP-884", "INCLUDES", "c-9f03b5d"); edge("c-9f03b5d", "AUTHORED_BY", "eng-ravi"); edge("c-9f03b5d", "MODIFIES", "mod-pay-ledgerclient")
node("ConfigChange", id="CFG-311", name="ledger.client.pool.max_size 50 → 8", key="ledger.client.pool.max_size",
     old_value="50", new_value="8", env="prod", ts=t("13:52"))
node("ConfigChange", id="CFG-312", name="ledger.client.retry.max_attempts 2 → 5", key="ledger.client.retry.max_attempts",
     old_value="2", new_value="5", env="prod", ts=t("13:52"))
for cfg, fm in [("CFG-311", "fm-pool-exhaustion"), ("CFG-312", "fm-retry-storm")]:
    edge("DEP-884", "SHIPS", cfg); edge(cfg, "APPLIED_TO", "svc-payment"); edge(cfg, "CHANGED_BY", "eng-ravi"); edge(cfg, "TOUCHES", fm)

node(("ConfigChange", "Change"), id="CFG-319", name="consumer.concurrency 16 → 4", key="consumer.concurrency",
     old_value="16", new_value="4", env="prod", ts=t("13:58"))
edge("CFG-319", "APPLIED_TO", "svc-notify"); edge("CFG-319", "CHANGED_BY", "eng-lin"); edge("CFG-319", "TOUCHES", "fm-consumer-lag")

node(("Deployment", "Change"), id="DEP-886", name="ledger-service v1.9.4", version="v1.9.4", env="prod", ts=t("14:25"), status="succeeded")
edge("DEP-886", "DEPLOYED_TO", "svc-ledger")
node("Commit", id="c-5c8a7e1", name="Expose per-route latency metrics", sha="5c8a7e1", ts=t("14:10"))
edge("DEP-886", "INCLUDES", "c-5c8a7e1"); edge("c-5c8a7e1", "AUTHORED_BY", "eng-jo"); edge("c-5c8a7e1", "MODIFIES", "mod-ledger-metrics")

# --- Signals --------------------------------------------------------------------
# :Signal = an observation (metric anomaly or log event). INDICATES links it to the mechanism it is evidence of.
SIGNALS = [
    ("MetricSignal", "MET-5101", "svc-payment", "13:57", dict(name="ledger_client.pool.in_use", baseline="11", observed="8/8 (saturated)", unit="conns"), "fm-pool-exhaustion"),
    ("MetricSignal", "MET-5102", "svc-payment", "13:58", dict(name="ledger_client.pool.wait_ms p99", baseline="3", observed="1840", unit="ms"), "fm-pool-exhaustion"),
    ("LogEvent", "LOG-7710", "svc-payment", "13:59", dict(name="PoolTimeout acquiring ledger connection", level="ERROR",
        message="LedgerClient: timed out after 2000ms acquiring connection (pool max_size=8, waiting=143)"), "fm-pool-exhaustion"),
    ("LogEvent", "LOG-7724", "svc-payment", "14:01", dict(name="Retrying ledger.post_entry", level="WARN",
        message="retrying ledger.post_entry attempt 4/5 (cause: PoolTimeout)"), "fm-retry-storm"),
    ("MetricSignal", "MET-5107", "svc-ledger", "14:02", dict(name="http.requests_per_s", baseline="410", observed="1130", unit="req/s"), "fm-retry-storm"),
    ("MetricSignal", "MET-5110", "ext-paylane", "14:00", dict(name="api.p99_ms", baseline="420", observed="455", unit="ms"), None),
    ("MetricSignal", "MET-5111", "db-ledger", "14:00", dict(name="cpu.utilization", baseline="34", observed="29", unit="%"), None),
    ("MetricSignal", "MET-5120", "svc-checkout", "14:05", dict(name="http.server.p99_ms", baseline="180", observed="3400", unit="ms"), "fm-upstream-timeout"),
    ("LogEvent", "LOG-7741", "svc-checkout", "14:06", dict(name="payment-service call timed out", level="ERROR",
        message="POST payment-service/v1/charges timed out after 3000ms"), "fm-upstream-timeout"),
    ("MetricSignal", "MET-5130", "svc-notify", "14:10", dict(name="consumer.lag", baseline="120", observed="9800", unit="msgs"), "fm-consumer-lag"),
]
for label, sid, svc, hhmm, props, fm in SIGNALS:
    node((label, "Signal"), id=sid, ts=t(hhmm), env="prod", **props)
    edge(sid, "OBSERVED_IN", svc)
    if fm:
        edge(sid, "INDICATES", fm)
edge("LOG-7741", "REFERENCES", "svc-payment")

# --- Alerts & incidents -------------------------------------------------------
for aid, name, svc, sev, hhmm in [
    ("ALR-9001", "checkout p99 latency > 2s", "svc-checkout", "critical", "14:07"),
    ("ALR-9002", "gateway 5xx rate > 3%", "svc-gateway", "high", "14:08"),
    ("ALR-9003", "notification consumer lag > 5k", "svc-notify", "warning", "14:12"),
]:
    node("Alert", id=aid, name=name, severity=sev, ts=t(hhmm), env="prod")
    edge(aid, "FIRED_ON", svc)

node("Incident", id="INC-2041", name="Checkout latency and 5xx spike", status="open", severity="SEV-2", ts=t("14:07"), env="prod",
     summary="Customers see slow checkout and failed card payments; payment latency spike reported by support.")
edge("INC-2041", "TRIGGERED_BY", "ALR-9001"); edge("INC-2041", "TRIGGERED_BY", "ALR-9002")
node("Incident", id="INC-2042", name="Delayed order notifications", status="open", severity="SEV-4", ts=t("14:12"), env="prod",
     summary="Order confirmation emails and pushes are delayed.")
edge("INC-2042", "TRIGGERED_BY", "ALR-9003")

INDEXED_LABELS = ["Service", "Team", "Engineer", "Change", "Deployment", "ConfigChange", "Commit", "CodeModule", "Test",
                  "Signal", "Alert", "Incident", "FailureMode", "Runbook", "Investigation", "Action"]


def load(g) -> dict:
    """Idempotent load. Returns node/edge counts after loading."""
    existing = {(c["label"], tuple(c["properties"])) for c in _constraints(g)}
    for label in INDEXED_LABELS:
        if (label, ("id",)) not in existing:
            try:
                g.create_node_range_index(label, "id")
            except Exception as e:  # already indexed
                if "already indexed" not in str(e):
                    raise
            g.create_node_unique_constraint(label, "id")

    primary = {}
    by_labels: dict[tuple, list] = {}
    for labels, props in NODES:
        primary[props["id"]] = labels[0]
        by_labels.setdefault(labels, []).append(props)
    for labels, rows in by_labels.items():
        # Labels come from the fixed tuples above, never from user input.
        g.query(f"UNWIND $rows AS r MERGE (n:{labels[0]} {{id: r.id}}) SET n += r"
                + "".join(f", n:{extra}" for extra in labels[1:]), {"rows": rows})

    by_type: dict[tuple, list] = {}
    for src, typ, dst, props in EDGES:
        by_type.setdefault((primary[src], typ, primary[dst]), []).append({"src": src, "dst": dst, "props": props})
    for (sl, typ, dl), rows in by_type.items():
        g.query(f"UNWIND $rows AS r MATCH (a:{sl} {{id: r.src}}), (b:{dl} {{id: r.dst}}) "
                f"MERGE (a)-[e:{typ}]->(b) SET e += r.props", {"rows": rows})
    return counts(g)


def _constraints(g):
    try:
        return g.list_constraints()
    except Exception:
        return []


def counts(g) -> dict:
    # seed facts only: excludes DevRoot's own records (investigations, actions) and fire-drill data
    n = g.ro_query("MATCH (n) WHERE NOT n:Investigation AND NOT n:Action AND n.source = $s RETURN count(n)",
                   {"s": SOURCE}).result_set[0][0]
    e = g.ro_query("MATCH (a)-[r]->(b) WHERE a.source = $s AND b.source = $s RETURN count(r)", {"s": SOURCE}).result_set[0][0]
    return {"nodes": n, "edges": e}
