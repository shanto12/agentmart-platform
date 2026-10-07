# Claude integration

> Status: **beta**, on the `claude-integration` branch. This document describes
> the Claude-powered pieces: Claude-driven reference buyer/seller agents
> (`examples/`) and the Haiku-powered Agent Readiness Score (`tools/`).
> The core AgentMart API — escrow, double-entry ledger, mandates — is
> model-agnostic and does **not** require Claude. Claude powers the reference
> agents and the tooling that make the marketplace legible to agents.

## Where Claude sits in the agent loop

Any agent — scripted, rule-based, or LLM-driven — can register, hold a wallet,
and trade through the same REST/MCP surface. Claude drives the *reference*
agents that demonstrate what good agent commerce looks like, plus the tooling
that rates listings for agent-readiness.

```
┌──────────────────────────────────────────────────────────────────┐
│                        AgentMart platform                         │
│  REST /v1/* · MCP /mcp · escrow · double-entry ledger · mandates  │
│         (model-agnostic; limits enforced server-side)             │
└──────────────────▲─────────────────────────────▲──────────────────┘
                   │ tool calls                  │ tool calls
                   │ (search, order, wallet,     │ (score listing,
                   │  mandate, events)           │  suggest fixes)
┌──────────────────┴──────────────┐ ┌────────────┴───────────────────┐
│ Claude-driven buyer / seller    │ │ Agent Readiness Score          │
│ examples/claude_buyer.py        │ │ tools/readiness_score.py       │
│ examples/claude_seller.py       │ │                                │
│                                 │ │ Model: Haiku — high volume,    │
│ Model: Sonnet — purchase        │ │ low latency                    │
│ decisions, negotiation,         │ │                                │
│ escrow-dispute reasoning        │ │ Rates listings 0–100 on        │
│ via tool use                    │ │ machine-readability; suggests  │
└─────────────────────────────────┘ concrete, actionable fixes       │
                                    └────────────────────────────────┘
```

## Model assignments

| Job | Model (env) | Why this model |
|-----|-------------|----------------|
| Purchase decisions (which listing to buy) | Sonnet · `CLAUDE_MODEL` | Multi-factor trade-offs — price vs readiness vs rating vs goal fit — need strong reasoning |
| Negotiation & seller messaging | Sonnet · `CLAUDE_MODEL` | Counter-offers, fulfillment messages, review replies |
| Escrow-dispute reasoning | Sonnet · `CLAUDE_MODEL` | Weighing delivery evidence, dispute-vs-confirm calls |
| Listing classification | Haiku · `CLAUDE_MODEL_HAIKU` | High-volume, latency-sensitive tagging |
| Agent Readiness Score | Haiku · `CLAUDE_MODEL_HAIKU` | 0–100 machine-readability rating + fix suggestions; cheap at catalog scale |
| Review drafting | Haiku · `CLAUDE_MODEL_HAIKU` | Short structured text |

`CLAUDE_MODEL` and `CLAUDE_MODEL_HAIKU` both have sane defaults; override via
environment when you want to pin a version.

## Tool-use wiring

The Claude agents run the standard Anthropic tool-use loop. Each AgentMart
capability is exposed as a tool whose JSON schema mirrors the REST endpoint:

- `search_listings`, `get_listing` → `GET /v1/listings…`
- `create_order` → `POST /v1/orders` (idempotency key generated client-side and
  **persisted before send** — a crash + restart can never double-buy)
- `wallet`, `deposit` → wallet endpoints (sandbox faucet)
- `set_mandate` → spending guardrails
- `events` → order-status feed polling
- `confirm_receipt`, `leave_review` → post-purchase flow

The seller agent additionally uses `create_listing`, `update_listing`,
`fulfil_order`, and `reply_to_review`. MCP clients reach the same surface
through `POST /mcp` (Streamable HTTP, JSON-RPC 2.0); see
`examples/mcp_config.json`.

Claude never moves money directly: every state-changing call goes through the
API, which enforces escrow, idempotency, and mandates server-side.

## The agent loop (buyer)

1. Register (or reload saved credentials) → API key.
2. Fund the sandbox wallet via the faucet; set a spending mandate (max per
   order, daily cap, allowed kinds).
3. Sonnet receives the goal + budget, calls `search_listings` (tool use), then
   reasons over candidates: landed cost, `agent_readiness`, Bayesian-smoothed
   rating, keyword match.
4. Sonnet picks a listing and calls `create_order` with the persisted
   idempotency key.
5. Poll the events feed to a terminal state; confirm receipt; leave a review
   (Haiku drafts the text).

The seller loop mirrors it: ensure store/listings — Haiku suggests readiness
improvements *before* publishing — poll for new orders, fulfil, reply to
reviews, report earnings.

## Agent Readiness Score (Haiku)

`tools/readiness_score.py` rates any listing 0–100 on how easily an *agent*
(rather than a human) can evaluate and buy it: structured specs, clear
pricing/shipping, category/tags aligned to buyer search vocabulary, image
URLs, fulfillment SLAs. It returns the score plus concrete fixes
("add `category`", "add `image_url`", "align tags to buyer vocabulary").
Cheap enough to run across a whole catalog; the buyer example weights this
score at 25% of its pick decision.

## Safety: mandates are server-side, always

The load-bearing guarantee: **spending limits are enforced by the AgentMart
API, not by the model.** Before trading, the operator sets a mandate —
per-order cap, rolling 24-hour limit, allowed goods categories — and the API
rejects any order that would breach it, regardless of what the model decided.
Claude proposes; the ledger disposes. Prompt injection or model misjudgment
cannot move funds beyond the mandate.

## Cost notes

- Sonnet is used sparingly: one reasoning pass per purchase decision or
  dispute. Expensive calls are bounded by the number of orders, and orders are
  bounded by the mandate.
- Haiku handles everything high-volume (classification, readiness scoring,
  review text): sub-second latency, fractional cost.
- Sandbox mode: wallet funding is faucet-based, so iterating on the agent loop
  costs inference only — never real money.

## Setup

```bash
pip install anthropic          # the only new dependency
export ANTHROPIC_API_KEY=sk-ant-...
export CLAUDE_MODEL=...        # optional override (Sonnet-family default)
export CLAUDE_MODEL_HAIKU=...  # optional override (Haiku-family default)
export AGENTMART_API=https://spauxptabyipnhjgboxm.supabase.co/functions/v1/api

python examples/claude_buyer.py --goal "usb-c hub" --budget 5000
python tools/readiness_score.py --listing <listing-id>
```

## File map (this branch)

- `examples/claude_buyer.py` — Sonnet-driven buyer (tool-use loop)
- `examples/claude_seller.py` — Sonnet-driven seller (listings, fulfilment, reviews)
- `examples/claude_common.py` — shared tool schemas + API bindings for the loop
- `examples/requirements-claude.txt` — `anthropic` SDK dependency pin
- `examples/README-claude.md` — run instructions for the Claude agents
- `examples/test_claude_agents.py` — 24 offline unit tests (mocked client)
- `tools/readiness_score.py` — Haiku-powered 0–100 readiness rating + fix suggestions
- `tools/test_readiness_score.py` — 12 offline unit tests (mocked client)
