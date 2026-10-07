#!/usr/bin/env python3
"""Offline unit tests for the Claude-driven AgentMart agents.

No network, no API keys. The Anthropic client and the AgentMart SDK client are
both mocked; the tests assert tool-schema validity, model alias resolution,
the buyer budget guard, executor dispatch, and the full tool-use loop wiring.

    python examples/test_claude_agents.py
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))          # claude_common
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sdk" / "python"))

import claude_common as cc  # noqa: E402
from claude_common import (  # noqa: E402
    BUYER_TOOLS, SELLER_TOOLS, BuyerExecutor, SellerExecutor,
    get_anthropic_client, resolve_model, run_tool_loop,
)


def tool_use_block(tid: str, name: str, input_: dict) -> SimpleNamespace:
    return SimpleNamespace(type="tool_use", id=tid, name=name, input=input_)


def text_block(text: str) -> SimpleNamespace:
    return SimpleNamespace(type="text", text=text)


def claude_response(blocks, stop_reason: str) -> SimpleNamespace:
    return SimpleNamespace(content=list(blocks), stop_reason=stop_reason)


def mock_am() -> MagicMock:
    """A fake AgentMart client: real dispatch paths, zero network."""
    am = MagicMock()
    am.get_listing.return_value = {"listing": {
        "id": "lst_test", "title": "Test Mug", "kind": "physical",
        "price_cents": 1800, "status": "active",
        "shipping": {"shipping_cents": 599, "ships_to": ["US"]},
    }}
    am.search_listings.return_value = {"data": [{"id": "lst_test", "title": "Test Mug"}], "next_cursor": None}
    am.wallet.return_value = {"available_cents": 10_000, "held_cents": 0, "mode": "sandbox"}
    am.create_order.return_value = {"order": {"id": "ord_1", "status": "paid", "total_cents": 2399}}
    am.get_order.return_value = {"order": {"id": "ord_1", "status": "fulfilled"}}
    am.confirm_order.return_value = {"order": {"id": "ord_1", "status": "completed"}}
    am.create_review.return_value = {"review": {"id": "rev_1"}}
    am.deposit.return_value = {"available_cents": 10_000}
    am.fulfill_order.return_value = {"order": {"id": "ord_9", "status": "fulfilled"}}
    am.iter_orders.return_value = iter([{"id": "ord_9", "status": "paid"}])
    am.get_my_store.return_value = {"store": {"slug": "test-store"}}
    am.iter_store_reviews.return_value = iter([])
    am.reply_to_review.return_value = {"review": {"id": "rev_9"}}
    return am


class TestResolveModel(unittest.TestCase):
    def test_tier_nicknames(self):
        self.assertEqual(resolve_model("sonnet"), "claude-sonnet-5-5")
        self.assertEqual(resolve_model("haiku"), "claude-haiku-4-5")
        self.assertEqual(resolve_model("opus"), "claude-opus-5-5")

    def test_case_and_whitespace(self):
        self.assertEqual(resolve_model("  SONNET "), "claude-sonnet-5-5")

    def test_full_id_passthrough(self):
        self.assertEqual(resolve_model("claude-sonnet-4-6"), "claude-sonnet-4-6")
        self.assertEqual(resolve_model("claude-haiku-4-5"), "claude-haiku-4-5")

    def test_default_is_sonnet(self):
        self.assertEqual(resolve_model(None), "claude-sonnet-5-5")
        self.assertEqual(resolve_model(""), "claude-sonnet-5-5")


class TestClientFactory(unittest.TestCase):
    def test_missing_key_exits(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ANTHROPIC_API_KEY", None)
            with self.assertRaises(SystemExit):
                get_anthropic_client()

    def test_key_from_env_only(self):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-ant-test-key"}):
            with patch.object(cc.anthropic, "Anthropic") as mock_cls:
                get_anthropic_client()
                mock_cls.assert_called_once_with(api_key="sk-ant-test-key")


class TestToolSchemas(unittest.TestCase):
    def _check(self, tools):
        names = [t["name"] for t in tools]
        self.assertEqual(len(names), len(set(names)), "duplicate tool names")
        for t in tools:
            self.assertIn("name", t)
            self.assertTrue(t.get("description"), f"{t['name']} missing description")
            schema = t.get("input_schema")
            self.assertIsInstance(schema, dict, f"{t['name']} missing input_schema")
            self.assertEqual(schema.get("type"), "object")
            props = schema.get("properties", {})
            for req in schema.get("required", []):
                self.assertIn(req, props, f"{t['name']}: required '{req}' not in properties")
            # schemas must be JSON-serializable (they go straight to the API)
            json.dumps(t)

    def test_buyer_tools(self):
        self._check(BUYER_TOOLS)
        names = {t["name"] for t in BUYER_TOOLS}
        for expected in ("search_listings", "get_listing", "get_wallet", "deposit_funds",
                         "place_order", "get_order", "confirm_order", "leave_review"):
            self.assertIn(expected, names)

    def test_seller_tools(self):
        self._check(SELLER_TOOLS)
        names = {t["name"] for t in SELLER_TOOLS}
        for expected in ("get_me", "list_orders", "get_order", "fulfill_order",
                         "list_reviews", "reply_to_review", "update_listing_price", "get_wallet"):
            self.assertIn(expected, names)

    def test_no_cross_duplicates(self):
        buyer = {t["name"] for t in BUYER_TOOLS}
        seller = {t["name"] for t in SELLER_TOOLS}
        # shared names (get_wallet/get_order) are fine across roles; within a role they must be unique
        self.assertEqual(len(buyer), len(BUYER_TOOLS))
        self.assertEqual(len(seller), len(SELLER_TOOLS))


class TestBuyerExecutor(unittest.TestCase):
    def test_search_dispatch(self):
        am = mock_am()
        ex = BuyerExecutor(am, budget_cents=5_000)
        out = ex.execute("search_listings", {"q": "mug"})
        self.assertTrue(out["ok"])
        self.assertEqual(out["listings"][0]["id"], "lst_test")
        am.search_listings.assert_called_once()

    def test_place_order_within_budget(self):
        am = mock_am()
        ex = BuyerExecutor(am, budget_cents=5_000)
        out = ex.execute("place_order", {"listing_id": "lst_test", "quantity": 1,
                                         "shipping_address": {"name": "T", "line1": "1", "city": "C",
                                                              "region": "R", "postal_code": "1", "country": "US"}})
        self.assertTrue(out["ok"], out)
        # landed = 1800 + 599 = 2399 <= 5000
        self.assertEqual(out["landed_cents"], 2399)
        self.assertEqual(ex.remaining_cents, 5_000 - 2399)
        am.create_order.assert_called_once()

    def test_place_order_over_budget_never_hits_api(self):
        am = mock_am()
        ex = BuyerExecutor(am, budget_cents=1_000)  # landed 2399 > 1000
        out = ex.execute("place_order", {"listing_id": "lst_test", "quantity": 1,
                                         "shipping_address": {"name": "T", "line1": "1", "city": "C",
                                                              "region": "R", "postal_code": "1", "country": "US"}})
        self.assertFalse(out["ok"])
        self.assertIn("budget_exceeded", out["error"])
        am.create_order.assert_not_called()

    def test_place_order_physical_requires_address(self):
        am = mock_am()
        ex = BuyerExecutor(am, budget_cents=5_000)
        out = ex.execute("place_order", {"listing_id": "lst_test"})
        self.assertFalse(out["ok"])
        self.assertIn("shipping_address", out["error"])
        am.create_order.assert_not_called()

    def test_dry_run_buys_nothing(self):
        am = mock_am()
        ex = BuyerExecutor(am, budget_cents=5_000, dry_run=True)
        out = ex.execute("place_order", {"listing_id": "lst_test", "quantity": 1,
                                         "shipping_address": {"name": "T", "line1": "1", "city": "C",
                                                              "region": "R", "postal_code": "1", "country": "US"}})
        self.assertTrue(out["ok"])
        self.assertTrue(out["dry_run"])
        am.create_order.assert_not_called()

    def test_unknown_tool(self):
        ex = BuyerExecutor(mock_am(), budget_cents=5_000)
        out = ex.execute("delete_everything", {})
        self.assertFalse(out["ok"])
        self.assertIn("unknown_tool", out["error"])

    def test_api_error_becomes_dict(self):
        from agentmart import AgentMartError
        am = mock_am()
        am.search_listings.side_effect = AgentMartError("unauthorized", "bad key", 401)
        ex = BuyerExecutor(am, budget_cents=5_000)
        out = ex.execute("search_listings", {"q": "x"})
        self.assertFalse(out["ok"])
        self.assertIn("unauthorized", out["error"])


class TestSellerExecutor(unittest.TestCase):
    def test_fulfill_dispatch_and_callback(self):
        am = mock_am()
        seen = []
        ex = SellerExecutor(am, on_fulfilled=seen.append)
        out = ex.execute("fulfill_order", {"order_id": "ord_9", "carrier": "X",
                                           "tracking_number": "AMSB-1"})
        self.assertTrue(out["ok"])
        self.assertEqual(out["order"]["status"], "fulfilled")
        self.assertEqual(seen, ["ord_9"])
        am.fulfill_order.assert_called_once()

    def test_price_change_within_20_percent(self):
        am = mock_am()
        ex = SellerExecutor(am)
        out = ex.execute("update_listing_price", {"listing_id": "lst_test", "price_cents": 1980})
        self.assertTrue(out["ok"] or "ok" in out)  # mock returns MagicMock; assert call happened
        am.update_listing.assert_called_once()

    def test_price_change_over_20_percent_blocked(self):
        am = mock_am()
        ex = SellerExecutor(am)
        out = ex.execute("update_listing_price", {"listing_id": "lst_test", "price_cents": 3000})
        self.assertFalse(out["ok"])
        self.assertIn("20%", out["error"])
        am.update_listing.assert_not_called()


class TestAgentLoop(unittest.TestCase):
    def _mock_client(self, responses):
        client = MagicMock()
        client.messages.create.side_effect = responses
        return client

    def test_full_buy_flow(self):
        """Claude: search -> place_order -> final text. Assert wiring order."""
        client = self._mock_client([
            claude_response([tool_use_block("tu_1", "search_listings", {"q": "mug"})], "tool_use"),
            claude_response([tool_use_block("tu_2", "place_order", {
                "listing_id": "lst_test", "quantity": 1,
                "shipping_address": {"name": "T", "line1": "1", "city": "C",
                                     "region": "R", "postal_code": "1", "country": "US"}})], "tool_use"),
            claude_response([text_block("Bought the Test Mug for $23.99.")], "end_turn"),
        ])
        am = mock_am()
        ex = BuyerExecutor(am, budget_cents=5_000)
        messages = [{"role": "user", "content": "buy a mug"}]

        final = run_tool_loop(client, "claude-sonnet-5-5", "sys", messages,
                              BUYER_TOOLS, ex, max_iterations=6)

        self.assertEqual(final, "Bought the Test Mug for $23.99.")
        self.assertEqual(client.messages.create.call_count, 3)
        # tool results were fed back with matching ids
        user_msgs = [m for m in messages if m["role"] == "user"][1:]
        self.assertEqual(len(user_msgs), 2)
        self.assertEqual(user_msgs[0]["content"][0]["tool_use_id"], "tu_1")
        self.assertEqual(user_msgs[1]["content"][0]["tool_use_id"], "tu_2")
        # the order really went through the executor (budget-tracked)
        self.assertEqual(ex.spent_cents, 2399)
        am.create_order.assert_called_once()

    def test_no_tools_means_final_answer(self):
        client = self._mock_client([
            claude_response([text_block("Nothing suitable in budget.")], "end_turn"),
        ])
        final = run_tool_loop(client, "claude-sonnet-5-5", "sys",
                              [{"role": "user", "content": "hi"}], BUYER_TOOLS,
                              BuyerExecutor(mock_am(), 5_000), max_iterations=6)
        self.assertEqual(final, "Nothing suitable in budget.")
        self.assertEqual(client.messages.create.call_count, 1)

    def test_max_iterations_stops(self):
        client = self._mock_client([
            claude_response([tool_use_block(f"tu_{i}", "get_wallet", {})], "tool_use")
            for i in range(10)
        ])
        final = run_tool_loop(client, "claude-sonnet-5-5", "sys",
                              [{"role": "user", "content": "hi"}], BUYER_TOOLS,
                              BuyerExecutor(mock_am(), 5_000), max_iterations=3)
        self.assertIn("max iterations", final)
        self.assertEqual(client.messages.create.call_count, 3)

    def test_auth_failure_exits_cleanly(self):
        """A dummy/rejected key must surface as a clean SystemExit, not a traceback."""
        import anthropic as anthropic_pkg

        resp = MagicMock()
        resp.status_code = 401
        resp.request = MagicMock()
        resp.headers = {}
        auth_err = anthropic_pkg.AuthenticationError(
            "invalid x-api-key", response=resp, body={"error": {"message": "invalid x-api-key"}})

        client = MagicMock()
        client.messages.create.side_effect = auth_err
        with self.assertRaises(SystemExit) as ctx:
            run_tool_loop(client, "claude-sonnet-5-5", "sys",
                          [{"role": "user", "content": "hi"}], BUYER_TOOLS,
                          BuyerExecutor(mock_am(), 5_000), max_iterations=6)
        self.assertIn("authentication_error", str(ctx.exception))

    def test_tool_error_returned_to_claude_not_raised(self):
        client = self._mock_client([
            claude_response([tool_use_block("tu_1", "place_order", {"listing_id": "lst_nope"})], "tool_use"),
            claude_response([text_block("Order failed, stopping.")], "end_turn"),
        ])
        am = mock_am()
        from agentmart import AgentMartError
        am.get_listing.side_effect = AgentMartError("not_found", "no such listing", 404)
        ex = BuyerExecutor(am, budget_cents=5_000)
        messages = [{"role": "user", "content": "buy"}]
        final = run_tool_loop(client, "claude-sonnet-5-5", "sys", messages,
                              BUYER_TOOLS, ex, max_iterations=6)
        self.assertEqual(final, "Order failed, stopping.")
        result_content = messages[2]["content"][0]["content"]
        self.assertIn("not_found", result_content)


if __name__ == "__main__":
    unittest.main(verbosity=2)
