"""FalkorDB connection. FALKORDB_URL → external server (Docker / FalkorDB Cloud); unset → embedded falkordblite."""
import os
from pathlib import Path

from redis.exceptions import ConnectionError as RedisConnectionError, TimeoutError as RedisTimeoutError


class GraphUnavailable(RuntimeError):
    pass


GRAPH_ERRORS = (RedisConnectionError, RedisTimeoutError, ConnectionRefusedError, OSError)
_graph = None


def graph():
    global _graph
    if _graph is None:
        name = os.environ.get("DEVROOT_GRAPH", "devroot")
        try:
            url = os.environ.get("FALKORDB_URL")
            if url:
                from falkordb import FalkorDB
                db = FalkorDB.from_url(url, socket_timeout=5)
            else:
                from redislite.falkordb_client import FalkorDB
                path = Path(os.environ.get("DEVROOT_DB_PATH", Path(__file__).resolve().parents[2] / "data" / "devroot.db"))
                path.parent.mkdir(parents=True, exist_ok=True)
                db = FalkorDB(str(path))
            g = db.select_graph(name)
            g.query("RETURN 1")
        except GRAPH_ERRORS as e:
            raise GraphUnavailable(f"FalkorDB unreachable: {type(e).__name__}") from e
        _graph = g
    return _graph


def reset_connection():
    global _graph
    _graph = None
