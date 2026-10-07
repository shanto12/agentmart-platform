#!/usr/bin/env python3
"""AgentMart "Agent Readiness Score" evaluator (stdlib only).

Scores each listing in a seller catalog 0-100 on how ready it is for AI-agent
buyers, using a Haiku-tier Claude model via the Anthropic Messages API. This
makes the ``agent_readiness`` score advertised on the AgentMart site real.

The Anthropic SDK is used when installed (``pip install anthropic``);
otherwise a stdlib urllib fallback performs the identical Messages API call,
keeping this tool dependency-free like the rest of the repo.

    ANTHROPIC_API_KEY=sk-ant-... python3 tools/readiness_score.py examples/catalog.json
    cat catalog.json | ANTHROPIC_API_KEY=sk-ant-... python3 tools/readiness_score.py
    python3 tools/readiness_score.py catalog.json --estimate        # no API call
    python3 tools/readiness_score.py catalog.json --out report.json --batch-size 3

Env:
    ANTHROPIC_API_KEY   required (unless --estimate)
    CLAUDE_MODEL_HAIKU  model id, default ``claude-haiku-4-5-20251001``
    ANTHROPIC_BASE_URL  default ``https://api.anthropic.com``

Exit codes: 0 = report written, 1 = scoring/API failure, 2 = usage/input error.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple
from urllib import error as urlerror
from urllib import request as urlrequest

DEFAULT_MODEL = "claude-haiku-4-5-20251001"  # Haiku tier: cheap, fast, good enough
DEFAULT_BASE_URL = "https://api.anthropic.com"
DEFAULT_BATCH_SIZE = 5
ANTHROPIC_VERSION = "2023-06-01"
MAX_TOKENS = 1500

DIMENSIONS = (
    "title_clarity",
    "description_completeness",
    "pricing_clarity",
    "categorization_accuracy",
    "image_signals",
    "agent_parseability",
)

SYSTEM_PROMPT = """\
You are the AgentMart listing-quality judge. You score product listings for how
ready they are to be bought by AUTONOMOUS AI SHOPPING AGENTS (no humans in the loop).

Score each listing 0-100 on these dimensions:
- title_clarity: specific and informative; names the product, variant/size; no ALL-CAPS spam, no keyword stuffing.
- description_completeness: says what it is, key specs, what's included, and how/when it is delivered. Longer is not automatically better; completeness is.
- pricing_clarity: price is present and sane; currency clear (USD assumed); for physical goods, shipping cost/handling time stated or clearly absent.
- categorization_accuracy: category and tags actually match the product; the kind (physical/digital/service) is consistent with the fields given (physical should mention shipping/inventory, digital should describe delivery, service should state turnaround/deliverable).
- image_signals: an https image_url is present (strong positive); otherwise judge from textual visual detail. No image and no visual description scores low.
- agent_parseability: data an agent can act on without guessing — structured attributes with units, clear quantities, machine-readable specs, unambiguous fulfillment terms.

Also give each listing a single overall 0-100 score (your holistic judgment, roughly the mean of the dimensions) and a ONE-LINE concrete improvement tip (the single change that would raise the score most).

Reply with STRICT JSON ONLY — no prose, no markdown fences — in exactly this shape:
{"results": [{"index": <int>, "scores": {<dim>: <0-100 number>, ...all six...}, "score": <0-100 number>, "tip": "<one line>"}, ...]}
Include every input index exactly once, in order. Numbers only, no commentary.\
"""


class ReadinessError(Exception):
    """Scoring or API failure (exit 1)."""


class ClaudeClient:
    """Minimal Messages API client. Prefers the official SDK, falls back to urllib."""

    def __init__(self, api_key: str, model: str, base_url: str = DEFAULT_BASE_URL):
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self._sdk = None
        try:
            import anthropic  # type: ignore

            self._sdk = anthropic.Anthropic(api_key=api_key, base_url=base_url)
        except ImportError:
            self._sdk = None

    def complete(self, system: str, user: str, max_tokens: int = MAX_TOKENS) -> str:
        if self._sdk is not None:
            msg = self._sdk.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
            parts = [b.text for b in msg.content if getattr(b, "type", "") == "text"]
            return "".join(parts)
        payload = json.dumps(
            {
                "model": self.model,
                "max_tokens": max_tokens,
                "system": system,
                "messages": [{"role": "user", "content": user}],
            }
        ).encode()
        req = urlrequest.Request(
            self.base_url + "/v1/messages",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "x-api-key": self.api_key,
                "anthropic-version": ANTHROPIC_VERSION,
            },
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=60) as resp:
                body = json.loads(resp.read().decode())
        except urlerror.HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            raise ReadinessError(f"Anthropic API HTTP {e.code}: {detail}")
        except urlerror.URLError as e:
            raise ReadinessError(f"Anthropic API network error: {e}")
        texts = [b.get("text", "") for b in body.get("content", []) if b.get("type") == "text"]
        return "".join(texts)


def estimate_tokens(text: str) -> int:
    """Rough heuristic (~4 chars/token) for cost sanity; not a real tokenizer."""
    return max(1, len(text) // 4)


def _compact_listing(idx: int, listing: Dict[str, Any]) -> Dict[str, Any]:
    """Trim a listing to the fields the judge needs (keeps prompts small)."""
    keep = (
        "title", "description", "kind", "price_cents", "currency", "inventory",
        "category", "tags", "attributes", "image_url", "shipping",
        "digital_delivery", "service_terms",
    )
    out: Dict[str, Any] = {"index": idx}
    for k in keep:
        if k in listing and listing[k] is not None:
            out[k] = listing[k]
    return out


def _parse_results(raw: str, expected: Sequence[int]) -> List[Dict[str, Any]]:
    """Extract the results array from model output, tolerating fences/whitespace."""
    text = raw.strip()
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if m:
        text = m.group(1)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # last resort: grab the largest {...} span
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise ReadinessError(f"model did not return JSON: {raw[:300]!r}")
        data = json.loads(text[start : end + 1])
    results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(results, list):
        raise ReadinessError(f"model JSON missing 'results' array: {raw[:300]!r}")
    by_index = {r.get("index"): r for r in results if isinstance(r, dict)}
    parsed = []
    for i in expected:
        r = by_index.get(i)
        if r is None:
            raise ReadinessError(f"model omitted result for listing index {i}")
        scores = r.get("scores") if isinstance(r.get("scores"), dict) else {}
        clean_scores = {}
        for dim in DIMENSIONS:
            try:
                v = float(scores.get(dim, 0))
            except (TypeError, ValueError):
                v = 0.0
            clean_scores[dim] = round(min(100.0, max(0.0, v)), 1)
        try:
            overall = float(r.get("score", 0))
        except (TypeError, ValueError):
            overall = 0.0
        tip = r.get("tip")
        parsed.append(
            {
                "index": i,
                "scores": clean_scores,
                "score": round(min(100.0, max(0.0, overall)), 1),
                "tip": str(tip).strip() if tip else "No tip provided.",
            }
        )
    return parsed


def score_catalog(
    listings: List[Dict[str, Any]],
    client: ClaudeClient,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], int, int]:
    """Score valid listings in batches.

    Returns (results, skipped, api_calls, estimated_input_tokens).
    ``results`` entries carry index/title/kind/scores/score/tip.
    """
    valid: List[Tuple[int, Dict[str, Any]]] = []
    skipped: List[Dict[str, Any]] = []
    for i, item in enumerate(listings):
        if not isinstance(item, dict):
            skipped.append({"index": i, "reason": "listing is not a JSON object"})
            continue
        title = item.get("title")
        if not isinstance(title, str) or not title.strip():
            skipped.append({"index": i, "reason": "missing or empty title"})
            continue
        valid.append((i, item))

    by_index: Dict[int, Dict[str, Any]] = {i: item for i, item in valid}
    results: List[Dict[str, Any]] = []
    calls = 0
    est_tokens = estimate_tokens(SYSTEM_PROMPT)
    for start in range(0, len(valid), batch_size):
        chunk = valid[start : start + batch_size]
        compact = [_compact_listing(i, item) for i, item in chunk]
        user = "Score these AgentMart listings:\n" + json.dumps(compact, ensure_ascii=False)
        est_tokens += estimate_tokens(user)
        raw = client.complete(SYSTEM_PROMPT, user)
        calls += 1
        for parsed in _parse_results(raw, [i for i, _ in chunk]):
            idx = parsed["index"]
            item = by_index[idx]
            results.append(
                {
                    "index": idx,
                    "title": item.get("title"),
                    "kind": item.get("kind"),
                    "scores": parsed["scores"],
                    "score": parsed["score"],
                    "tip": parsed["tip"],
                }
            )
    results.sort(key=lambda r: r["index"])
    return results, skipped, calls, est_tokens


def build_report(
    results: List[Dict[str, Any]],
    skipped: List[Dict[str, Any]],
    model: str,
    received: int,
    calls: int,
    est_tokens: int,
) -> Dict[str, Any]:
    overall = (
        round(sum(r["score"] for r in results) / len(results), 1) if results else None
    )
    return {
        "tool": "readiness_score",
        "model": model,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "input": {"listings_received": received},
        "overall_score": overall,
        "listings": results,
        "skipped": skipped,
        "usage": {"api_calls": calls, "estimated_input_tokens": est_tokens},
    }


def load_catalog(source: str) -> Tuple[List[Any], int]:
    """Load listings from a file path, '-' or stdin. Returns (listings, received)."""
    if source == "-" or source is None:
        text = sys.stdin.read()
    else:
        with open(source, "r", encoding="utf-8") as f:
            text = f.read()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ReadinessError(f"invalid JSON input: {e}")
    if isinstance(data, dict) and isinstance(data.get("listings"), list):
        listings = data["listings"]
    elif isinstance(data, list):
        listings = data
    else:
        raise ReadinessError(
            "input must be a JSON array of listings or an object with a 'listings' array"
        )
    return listings, len(listings)


def main(
    argv: Optional[Sequence[str]] = None,
    env: Optional[Dict[str, str]] = None,
    client: Optional[ClaudeClient] = None,
) -> int:
    env = os.environ if env is None else env
    ap = argparse.ArgumentParser(description="Score an AgentMart catalog's agent-readiness (0-100).")
    ap.add_argument("catalog", nargs="?", default="-", help="JSON file path (or '-' / omit for stdin)")
    ap.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    ap.add_argument("--estimate", action="store_true", help="print estimated input tokens only; no API call")
    ap.add_argument("--out", default="-", help="write JSON report to file (default: stdout)")
    args = ap.parse_args(argv)

    if args.batch_size < 1:
        print("error: --batch-size must be >= 1", file=sys.stderr)
        return 2
    try:
        listings, received = load_catalog(args.catalog)
    except ReadinessError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except OSError as e:
        print(f"error: cannot read input: {e}", file=sys.stderr)
        return 2

    model = env.get("CLAUDE_MODEL_HAIKU", DEFAULT_MODEL)
    base_url = env.get("ANTHROPIC_BASE_URL", DEFAULT_BASE_URL)

    # Estimate cost up front (works without a key).
    probe = [_compact_listing(i, l) for i, l in enumerate(listings) if isinstance(l, dict)]
    est = estimate_tokens(SYSTEM_PROMPT) + sum(
        estimate_tokens(json.dumps(p, ensure_ascii=False)) for p in probe
    )
    print(f"estimated input tokens: ~{est} (heuristic)", file=sys.stderr)
    if args.estimate:
        return 0

    api_key = env.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("error: ANTHROPIC_API_KEY is not set", file=sys.stderr)
        return 2
    if client is None:
        client = ClaudeClient(api_key=api_key, model=model, base_url=base_url)

    try:
        results, skipped, calls, used_tokens = score_catalog(
            listings, client, batch_size=args.batch_size
        )
    except ReadinessError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    report = build_report(results, skipped, model, received, calls, used_tokens)
    out = json.dumps(report, indent=2, ensure_ascii=False)
    if args.out == "-":
        print(out)
    else:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out + "\n")
        print(f"report written to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
