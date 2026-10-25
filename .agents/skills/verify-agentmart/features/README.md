# AgentMart verification map

This directory is the maintained source for verifying the user-facing console. Read it before driving, then use the matching feature file.

## Baseline preconditions

- Launch from the repo root with `node .agents/skills/verify-agentmart/scripts/verify.mjs launch`.
- The server is `python3 -m http.server` bound to `127.0.0.1`, serving this checkout's `web/` directory.
- Run `doctor` and require a live pid, a listening port, and byte-identical `index.html` and `config.js`.
- Evidence for the run is `/tmp/agentmart-verify-evidence/<run_id>/`.
- Never drive a server that this run did not start.
- The public API is shared. One drive at a time. GETs only.

## Driving conventions

- Start every recipe from a doctored server.
- The harness is curl through `verify.mjs`. Do not send POST, PATCH, PUT, or DELETE.
- Hash URLs such as `#/market` stay in the browser. Curl `GET /` and assert the shell markers, then call the API the page would call.
- Treat paths, query keys, and evidence filenames in each feature file as literal.
- Keep proof files. Cleanup removes the server, not the evidence folder.

## Proof and skip reporting

- Save the response status and the body. Assert the field the feature names.
- Record the feature id in `<feature>/result.json`.
- Exit `2` and an `unmet` entry mean that entry point was not verified.
- Do not mark a skipped entry point verified because a different page returned 200.

## Features

- [Home](./home.md) covers the landing document, the pricing anchor, and live stats.
- [Marketplace](./marketplace.md) covers the search shell, the service descriptor, listing search, and categories.
- [Listing](./listing.md) covers an open listing and its purchase hint.
- [Store](./store.md) covers a public store and its reviews.
- [Developers](./developers.md) covers the docs shell, local `llms.txt`, and the API's public documents.
- [Console](./console.md) covers the signed-out shell. Signed-in journeys stay unmet.
