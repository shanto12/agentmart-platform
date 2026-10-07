#!/usr/bin/env python3
"""Unit tests for tools/readiness_score.py (stdlib only, no network).

The Anthropic client is faked: no API key and no HTTP calls are made.

    python3 tools/test_readiness_score.py
"""

from __future__ import annotations

import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from typing import Any, Dict, List

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

import readiness_score as rs  # noqa: E402


def _listing(title: str = "Test Widget", **kw: Any) -> Dict[str, Any]:
    base: Dict[str, Any] = {
        "title": title,
        "description": "A sturdy widget for testing.",
        "kind": "physical",
        "price_cents": 1999,
        "category": "tools",
        "tags": ["widget"],
        "attributes": {"weight_oz": 4},
        "image_url": "https://example.com/w.png",
        "shipping": {"handling_days": 1, "ships_to": ["US"], "shipping_cents": 299},
    }
    base.update(kw)
    return base


def _fake_payload(indices: List[int], score: float = 80.0, tip: str = "Add more specs.") -> str:
    return json.dumps(
        {
            "results": [
                {
                    "index": i,
                    "scores": {d: score for d in rs.DIMENSIONS},
                    "score": score,
                    "tip": tip,
                }
                for i in indices
            ]
        }
    )


class FakeClient:
    """Stand-in for ClaudeClient; records prompts, returns canned JSON."""

    def __init__(self, payloads: List[str]):
        self.payloads = list(payloads)
        self.calls: List[Dict[str, str]] = []

    def complete(self, system: str, user: str, max_tokens: int = 1500) -> str:
        self.calls.append({"system": system, "user": user})
        if not self.payloads:
            raise AssertionError("FakeClient: more API calls than canned payloads")
        return self.payloads.pop(0)


class ScoringTest(unittest.TestCase):
    def test_report_schema_and_scores(self):
        listings = [_listing("Widget A"), _listing("Widget B")]
        client = FakeClient([_fake_payload([0, 1], score=80.0)])
        results, skipped, calls, tokens = rs.score_catalog(listings, client, batch_size=5)
        self.assertEqual(calls, 1)
        self.assertEqual(skipped, [])
        self.assertGreater(tokens, 0)
        report = rs.build_report(results, skipped, "test-model", 2, calls, tokens)
        # schema
        for key in ("tool", "model", "generated_at", "input", "overall_score",
                    "listings", "skipped", "usage"):
            self.assertIn(key, report)
        self.assertEqual(report["tool"], "readiness_score")
        self.assertEqual(report["overall_score"], 80.0)
        self.assertEqual(len(report["listings"]), 2)
        first = report["listings"][0]
        self.assertEqual(first["title"], "Widget A")
        self.assertEqual(first["kind"], "physical")
        self.assertEqual(set(first["scores"].keys()), set(rs.DIMENSIONS))
        self.assertTrue(all(0 <= v <= 100 for v in first["scores"].values()))
        self.assertEqual(first["score"], 80.0)
        self.assertTrue(first["tip"])
        self.assertEqual(report["usage"]["api_calls"], 1)

    def test_overall_is_mean(self):
        listings = [_listing("A"), _listing("B")]
        payload = json.dumps({"results": [
            {"index": 0, "scores": {d: 100 for d in rs.DIMENSIONS}, "score": 100, "tip": "t"},
            {"index": 1, "scores": {d: 50 for d in rs.DIMENSIONS}, "score": 50, "tip": "t"},
        ]})
        client = FakeClient([payload])
        results, skipped, calls, tokens = rs.score_catalog(listings, client)
        report = rs.build_report(results, skipped, "m", 2, calls, tokens)
        self.assertEqual(report["overall_score"], 75.0)

    def test_malformed_listings_skipped_gracefully(self):
        listings: List[Any] = [
            {"description": "no title here"},   # missing title -> skipped
            "just a string",                    # not an object -> skipped
            {"title": "   "},                   # blank title -> skipped
            _listing("Good One"),
        ]
        client = FakeClient([_fake_payload([3])])
        results, skipped, calls, _ = rs.score_catalog(listings, client)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["title"], "Good One")
        self.assertEqual(len(skipped), 3)
        reasons = [s["reason"] for s in skipped]
        self.assertTrue(any("title" in r for r in reasons))
        self.assertTrue(any("object" in r for r in reasons))
        self.assertEqual([s["index"] for s in skipped], [0, 1, 2])

    def test_batching_keeps_costs_sane(self):
        listings = [_listing(f"Item {i}") for i in range(7)]
        client = FakeClient([_fake_payload([0, 1, 2]), _fake_payload([3, 4, 5]), _fake_payload([6])])
        results, _, calls, _ = rs.score_catalog(listings, client, batch_size=3)
        self.assertEqual(calls, 3)
        self.assertEqual(len(results), 7)
        # each batch prompt references only its own indices
        self.assertIn('"index": 0', client.calls[0]["user"])
        self.assertNotIn('"index": 3', client.calls[0]["user"])
        self.assertIn('"index": 6', client.calls[2]["user"])

    def test_code_fence_output_parsed(self):
        listings = [_listing("Fenced")]
        client = FakeClient(["```json\n" + _fake_payload([0]) + "\n```"])
        results, _, _, _ = rs.score_catalog(listings, client)
        self.assertEqual(results[0]["score"], 80.0)

    def test_scores_clamped_to_range(self):
        listings = [_listing("Wild")]
        payload = json.dumps({"results": [{
            "index": 0,
            "scores": {d: 150 for d in rs.DIMENSIONS} | {"title_clarity": -20},
            "score": 999,
            "tip": "t",
        }]})
        client = FakeClient([payload])
        results, _, _, _ = rs.score_catalog(listings, client)
        self.assertEqual(results[0]["score"], 100.0)
        self.assertEqual(results[0]["scores"]["description_completeness"], 100.0)
        self.assertEqual(results[0]["scores"]["title_clarity"], 0.0)

    def test_missing_scores_default_to_zero(self):
        listings = [_listing("Sparse")]
        payload = json.dumps({"results": [{"index": 0, "scores": {"title_clarity": 70}, "score": 70}]})
        client = FakeClient([payload])
        results, _, _, _ = rs.score_catalog(listings, client)
        self.assertEqual(results[0]["scores"]["title_clarity"], 70.0)
        self.assertEqual(results[0]["scores"]["agent_parseability"], 0.0)
        self.assertEqual(results[0]["tip"], "No tip provided.")

    def test_empty_catalog_report(self):
        report = rs.build_report([], [], "m", 0, 0, 10)
        self.assertIsNone(report["overall_score"])
        self.assertEqual(report["listings"], [])

    def test_missing_api_key_exits_2_without_network(self):
        env = {"PATH": os.environ.get("PATH", "")}  # no ANTHROPIC_API_KEY
        buf_out, buf_err = io.StringIO(), io.StringIO()
        with redirect_stdout(buf_out), redirect_stderr(buf_err):
            rc = rs.main(["tools/../tools/test-x.json"], env=env,
                         client=FakeClient([]))
        # input file doesn't exist -> usage error before any key check is fine too,
        # but the key check must come before any network use; assert no calls happened.
        self.assertIn(rc, (2,))
        # now with valid input but no key
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump([_listing()], f)
            path = f.name
        try:
            client = FakeClient([_fake_payload([0])])
            buf_out, buf_err = io.StringIO(), io.StringIO()
            with redirect_stdout(buf_out), redirect_stderr(buf_err):
                rc = rs.main([path], env=env, client=client)
            self.assertEqual(rc, 2)
            self.assertIn("ANTHROPIC_API_KEY", buf_err.getvalue())
            self.assertEqual(client.calls, [])  # no network attempted
        finally:
            os.unlink(path)

    def test_estimate_mode_needs_no_key_and_no_call(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"listings": [_listing()]}, f)
            path = f.name
        try:
            env = {"PATH": os.environ.get("PATH", "")}
            client = FakeClient([])
            buf_out, buf_err = io.StringIO(), io.StringIO()
            with redirect_stdout(buf_out), redirect_stderr(buf_err):
                rc = rs.main([path, "--estimate"], env=env, client=client)
            self.assertEqual(rc, 0)
            self.assertIn("estimated input tokens", buf_err.getvalue())
            self.assertEqual(client.calls, [])
        finally:
            os.unlink(path)

    def test_bad_json_input_exits_2(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write("{not json")
            path = f.name
        try:
            buf_out, buf_err = io.StringIO(), io.StringIO()
            with redirect_stdout(buf_out), redirect_stderr(buf_err):
                rc = rs.main([path], env={}, client=FakeClient([]))
            self.assertEqual(rc, 2)
        finally:
            os.unlink(path)

    def test_catalog_object_shape_accepted(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"store": {"name": "S"}, "listings": [_listing("Cat Item")]}, f)
            path = f.name
        try:
            client = FakeClient([_fake_payload([0])])
            env = {"ANTHROPIC_API_KEY": "x"}
            buf_out, buf_err = io.StringIO(), io.StringIO()
            with redirect_stdout(buf_out), redirect_stderr(buf_err):
                rc = rs.main([path], env=env, client=client)
            self.assertEqual(rc, 0)
            report = json.loads(buf_out.getvalue())
            self.assertEqual(report["input"]["listings_received"], 1)
            self.assertEqual(report["listings"][0]["title"], "Cat Item")
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
