"""Behavior tests for the generated Trace Flow Python client.

These run fully in isolation: a mock HTTP server stands in for the sandbox Data API,
so there is no live data, no database, and no network beyond loopback. They prove the
generated client actually imports and runs (paging, caching, validation, DataFrame
shape, docstrings) inside the real sandbox runtime (pandas + pydantic).

The generated client is written to /work/traceflow_client.py by the runner before this
file executes. Uses only the standard library (unittest) plus pandas, both present in
the sandbox image, so it needs no extra install.

Run via: bun run test:python  (from apps/analyst-sandbox)
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

CLIENT_DIR = os.environ.get("TRACEFLOW_CLIENT_DIR", "/work")
CACHE_DIR = "/tmp/tf_test_cache"


class _MockDataApi(BaseHTTPRequestHandler):
    """Pages list_traces across two pages; returns a single object for get_usage_summary."""

    calls: dict[str, int] = {}

    def log_message(self, *_args):  # silence request logging
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        tool = self.path.rsplit("/", 1)[-1]
        _MockDataApi.calls[tool] = _MockDataApi.calls.get(tool, 0) + 1

        if tool == "list_traces":
            pages = {
                "0": {
                    "data": [{"trace_id": "a", "cost_usd": 1.0}, {"trace_id": "b", "cost_usd": 2.0}],
                    "pagination": {"has_more": True, "next_cursor": "1"},
                },
                "1": {
                    "data": [{"trace_id": "c", "cost_usd": 3.0}],
                    "pagination": {"has_more": False},
                },
            }
            out = pages.get(str(body.get("cursor", "0")), {"data": [], "pagination": {"has_more": False}})
        elif tool == "get_usage_summary":
            out = {"total_cost_usd": 6.0, "total_requests": 3}
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{"error":"unknown tool"}')
            return

        payload = json.dumps(out).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(payload)


def _start_server() -> tuple[HTTPServer, int]:
    server = HTTPServer(("127.0.0.1", 0), _MockDataApi)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, port


class GeneratedClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server, port = _start_server()
        os.environ["TRACEFLOW_DATA_API_BASE_URL"] = f"http://127.0.0.1:{port}"
        os.environ["TRACEFLOW_DATA_CACHE_DIR"] = CACHE_DIR
        sys.path.insert(0, CLIENT_DIR)
        import traceflow_client  # noqa: E402  (import after env + sys.path setup)

        cls.module = traceflow_client
        cls.tf = traceflow_client.tf

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        _MockDataApi.calls.clear()
        shutil.rmtree(CACHE_DIR, ignore_errors=True)

    def test_imports_and_instantiates(self):
        self.assertTrue(hasattr(self.module, "tf"))
        self.assertTrue(hasattr(self.tf, "list_traces"))

    def test_auto_pages_into_one_dataframe(self):
        df = self.tf.list_traces(hours=168)
        self.assertEqual(list(df["trace_id"]), ["a", "b", "c"])
        self.assertEqual(df["cost_usd"].sum(), 6.0)
        self.assertEqual(_MockDataApi.calls["list_traces"], 2)  # two pages fetched

    def test_cache_hit_avoids_refetch(self):
        self.tf.list_traces(hours=168)
        first = _MockDataApi.calls["list_traces"]
        self.tf.list_traces(hours=168)
        self.assertEqual(_MockDataApi.calls["list_traces"], first)  # served from cache

    def test_refresh_flag_forces_refetch(self):
        self.tf.list_traces(hours=168)
        first = _MockDataApi.calls["list_traces"]
        self.tf.list_traces(hours=168, refresh=True)
        self.assertEqual(_MockDataApi.calls["list_traces"], first + 2)  # re-paged

    def test_distinct_args_are_separate_cache_keys(self):
        self.tf.list_traces(hours=168)
        before = _MockDataApi.calls["list_traces"]
        self.tf.list_traces(hours=24)
        self.assertGreater(_MockDataApi.calls["list_traces"], before)

    def test_ttl_expiry_refetches(self):
        self.tf.list_traces(hours=168)
        before = _MockDataApi.calls["list_traces"]
        for name in os.listdir(CACHE_DIR):
            path = os.path.join(CACHE_DIR, name)
            with open(path) as handle:
                entry = json.load(handle)
            entry["fetched_at"] = time.time() - 10_000  # well past the 5 min TTL
            with open(path, "w") as handle:
                json.dump(entry, handle)
        self.tf.list_traces(hours=168)
        self.assertGreater(_MockDataApi.calls["list_traces"], before)

    def test_raw_variant_returns_decoded_json_and_caches(self):
        summary = self.tf.get_usage_summary_raw(hours=168)
        self.assertEqual(summary, {"total_cost_usd": 6.0, "total_requests": 3})
        self.tf.get_usage_summary_raw(hours=168)
        self.assertEqual(_MockDataApi.calls["get_usage_summary"], 1)  # cached

    def test_single_object_becomes_one_row_dataframe(self):
        df = self.tf.get_usage_summary(hours=168)
        self.assertEqual(len(df), 1)
        self.assertEqual(df["total_cost_usd"].iloc[0], 6.0)

    def test_pydantic_rejects_unknown_argument(self):
        with self.assertRaises(Exception):
            self.tf.list_traces(hours=168, definitely_not_a_real_arg=1)

    def test_every_public_method_is_documented(self):
        import inspect

        cls = type(self.tf)
        public = [n for n, _ in inspect.getmembers(cls, inspect.isfunction) if not n.startswith("_")]
        self.assertGreater(len(public), 0)
        undocumented = [m for m in public if not (getattr(cls, m).__doc__ or "").strip()]
        self.assertEqual(undocumented, [], f"undocumented methods: {undocumented}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
