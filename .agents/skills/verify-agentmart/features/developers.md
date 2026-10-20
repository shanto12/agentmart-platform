# Developers

Developers is `#/developers`. The header link is in `index.html`. Section bodies are rendered by `developers.js` into `#devRoot`. The page also points at the API's `llms.txt`, OpenAPI document, and manifest.

## Sub-features

- `dev-shell` shows the developers view.
- `dev-source` contains the quickstart, MCP, and reference sections in `developers.js`.
- `dev-local-llms` serves the console's own `llms.txt`.
- `dev-api-docs` loads the API guide, OpenAPI document, and manifest.

## How to get to it (user POV)

- Choose `Developers` in the header (`href="#/developers"`).
- Choose `Quickstart` (`#/developers/quickstart`) or `MCP setup` (`#/developers/mcp`).
- Choose `Developer docs` from the home protocols section.

## Driving it with curl

Preconditions:

- `doctor` exited 0 for this run.

- **Open the developers shell.** Choose `Developers`. Run `node .agents/skills/verify-agentmart/scripts/verify.mjs get local / developers/index.html`. Status `200`. The body contains `id="view-developers"`, `id="devRoot"`, and `href="#/developers"`.
- **Read the section source.** The sections are not in the HTML until JavaScript runs. Run `node .agents/skills/verify-agentmart/scripts/verify.mjs get local /assets/developers.js developers/developers.js`. The file contains `id="dev-quickstart"`, `id="dev-mcp"`, `id="dev-reference"`, and `href="#/developers/quickstart"`.
- **Read the console guide.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs get local /llms.txt developers/llms.txt`. The body contains `AgentMart` and `GET /v1/listings`.
- **Read the API documents.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs get api /llms.txt developers/api-llms.txt`, then `node .agents/skills/verify-agentmart/scripts/verify.mjs get api /v1/openapi.json developers/openapi.json`, then `node .agents/skills/verify-agentmart/scripts/verify.mjs get api /.well-known/agentmart.json developers/manifest.json`. The API guide mentions `AgentMart` and `/v1/listings`. OpenAPI's `openapi` field starts with `3.`. The manifest `name` is `AgentMart` and `mcp.url` is a string.
- **Record the proof.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs assert developers`. Exit `0`. `developers/result.json` has `"feature": "developers"` and `"ok": true`.

## Gotchas

- Quickstart samples in `developers.js` contain `POST` examples. Do not execute them.
- The console `llms.txt` and the API `llms.txt` are different documents. Require the markers above, not byte equality.
- `#/developers/quickstart` does not fetch a different HTML file.
