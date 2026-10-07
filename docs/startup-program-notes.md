# Claude Startups — private application notes

> Internal planning notes for the founder. Not for publication. Everything
> below is scoped to what actually exists on the `claude-integration` branch
> as of 2026-10-07. Do not state anything here as shipped if it is still
> roadmap.

## What is genuinely Claude-integrated (this branch)

- **Claude-driven reference buyer/seller agents** (`examples/claude_buyer.py`,
  `examples/claude_seller.py`): Anthropic tool-use loop where Sonnet decides
  purchases, negotiates, and reasons over escrow disputes against the live
  AgentMart REST/MCP API. Example/reference code, beta.
- **Haiku-powered Agent Readiness Score** (`tools/readiness_score.py`):
  0–100 machine-readability rating for listings plus concrete fix suggestions.
  The buyer example weights this score in its pick decision.
- **Safety story is real and structural**: spending mandates (per-order caps,
  rolling daily limits, allowed categories) are enforced server-side by the
  API ledger — the model cannot exceed them. This is the strongest honest
  claim in the application.

## What is NOT Claude-integrated (do not claim)

- The core marketplace API (escrow, ledger, wallets, mandates) is
  **model-agnostic** — it works with scripted agents and any LLM, not just Claude.
- No production traffic runs on Claude today; there are no paying users and no
  inference-volume metrics to cite.
- The platform does not *require* Claude to function. Frame Claude as the
  engine of the reference agents and tooling, not of the marketplace itself.

## Suggested "How we use Claude" statement (2–3 sentences)

> AgentMart's reference agents — the autonomous buyer and seller that
> demonstrate the marketplace — run on Claude. Sonnet makes purchase
> decisions, negotiates, and reasons over escrow disputes via tool use
> against our REST/MCP API, while Haiku powers high-volume flows like the
> Agent Readiness Score that rates listings for machine-readability.
> Spending mandates are enforced server-side by our ledger, so Claude
> proposes and the ledger disposes — safe autonomous commerce by construction.

## Application checklist (from the Oct 2026 program terms)

- [ ] Apply from `hello@agentmart.us` (company-domain email — hard requirement)
- [ ] Include `https://agentmart.us` (live website — verification depends on it)
- [ ] Short description shows Claude central to the *agents*, honestly scoped
- [ ] Stage stated plainly: solo founder, bootstrapped, $0 revenue, sandbox beta
- [ ] Do not cite the $25K Anthology Fund figure — the self-serve tier is $1,000
- [ ] Credits apply to first-party Claude Console API only

## Rejection history (for context)

- 2026-10-06 ~23:51 CDT and ~00:00 CDT: two self-submitted applications were
  auto-rejected within minutes — "couldn't verify it from the details in the
  application" (work email + website verification tips). The `claude-integration`
  branch and this notes file exist to make the next application verifiable and
  concrete. Reapply only with materially stronger details.
