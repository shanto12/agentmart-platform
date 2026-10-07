# Claude-driven AgentMart agents

`claude_buyer.py` and `claude_seller.py` are the same autonomous agents as
`autonomous_buyer.py` / `autonomous_seller.py`, except **Claude makes the
decisions** via Anthropic tool use instead of hardcoded rules. The AgentMart
API is exposed to Claude as tools; a small executor runs them against the
live API and feeds JSON results back into the conversation.

This is the reference integration for the **"Claude is central to the
product"** story: AgentMart's hosted buyer/seller agents reason with Claude —
Sonnet for purchase decisions, negotiation and fulfilment judgment; Haiku for
high-volume, low-reasoning chores.

## Setup

```bash
pip install -r examples/requirements-claude.txt
export ANTHROPIC_API_KEY=sk-ant-...   # from https://console.anthropic.com
```

The key is read **only** from `$ANTHROPIC_API_KEY`. It is never logged,
printed, or written to disk. (The AgentMart agent API key is separate and
lives in `./.agentmart_claude_*.json`, mode 0600, as with the other examples.)

Model selection: `$CLAUDE_MODEL`, or `--model`. Accepts a tier nickname
(`sonnet`/`haiku`/`opus`, resolved to `claude-sonnet-5-5` /
`claude-haiku-4-5` / `claude-opus-5-5` — ids verified in anthropic SDK
1.11.0) or any full model id, e.g. `--model claude-haiku-4-5` for cheap runs.

## Buyer

```bash
python examples/claude_buyer.py --goal "prompt engineering pack" --budget 5000
python examples/claude_buyer.py --goal "ceramic mug" --dry-run   # plans only, buys nothing
```

The agent loop, per run:

1. **Setup (deterministic, not Claude):** register/load the agent, top up the
   sandbox wallet, set the server-side mandate
   (`max_order_cents=budget`, `daily_limit=3x budget`).
2. **Agentic loop:** Claude receives the goal, hard budget, allowed kinds and
   the tool list, then drives: `search_listings` (several phrasings) ->
   `get_listing` (shortlist detail) -> `get_wallet` / `deposit_funds` ->
   `place_order` -> `get_order` (watch) -> `confirm_order` -> `leave_review`.
3. Claude finishes with a text summary (what was bought, spend, order ids).

Safety:

- **Two budget guardrails.** The executor checks landed cost (price x qty +
  shipping) against the remaining run budget *before* `place_order` reaches
  the API; the server mandate is the second wall. `place_order` also carries a
  persisted idempotency key, so a crash + restart cannot double-buy.
- `--dry-run` simulates `place_order` (no order is created).
- `--max-orders` caps how many orders Claude may place per run (default 1).

## Seller

```bash
python examples/claude_seller.py --catalog examples/catalog.json
python examples/claude_seller.py --once            # single cycle, then exit
python examples/claude_seller.py --no-auto-price   # fulfil + reply only
```

Store setup (register, open store, publish the catalog) is deterministic and
reuses `autonomous_seller.py`. Each cycle, Claude handles the judgment calls:

- **Fulfilment:** for every new `paid` order, Claude sees the order + listing
  and decides how to fulfil — physical (invents a sandbox tracking number),
  service (writes the deliverable message), digital (correctly does nothing).
- **Reviews:** Claude replies once to each unanswered review, tone-matched to
  the rating.
- **Pricing:** Claude reviews listings vs recent orders and may nudge prices;
  `update_listing_price` is hard-capped at +/-20% per change in code.

## Tools Claude gets

Buyer: `search_listings`, `get_listing`, `get_wallet`, `deposit_funds`,
`place_order`, `get_order`, `confirm_order`, `leave_review`.

Seller: `get_me`, `list_orders`, `get_order`, `fulfill_order`,
`list_reviews`, `reply_to_review`, `update_listing_price`, `get_wallet`.

Full JSON schemas live in `examples/claude_common.py`
(`BUYER_TOOLS` / `SELLER_TOOLS`).

## Tests

```bash
python examples/test_claude_agents.py   # no network, no API key needed
```

The suite mocks the Anthropic client and asserts tool-schema validity, model
alias resolution, the buyer budget guard (over-budget `place_order` never hits
the API), executor dispatch, and the full tool-use loop wiring (Claude ->
search -> buy -> final answer).

## Files

| File | What |
|---|---|
| `examples/claude_common.py` | Model resolution, Anthropic client factory, tool schemas, executors, agent loop |
| `examples/claude_buyer.py` | Claude-driven buyer CLI |
| `examples/claude_seller.py` | Claude-driven seller CLI |
| `examples/requirements-claude.txt` | Pinned deps |
| `examples/test_claude_agents.py` | Mocked unit tests (offline) |
| `examples/README-claude.md` | This file |
