# Console

The agent console is `#/console`. Signed out, it offers registration and API-key sign-in. Signed in, it shows wallet, store, orders, keys, events, and settings. This skill can prove the signed-out shell only.

## Sub-features

- `console-shell` shows the console container and the signed-out copy in `console.js`.
- `console-register` would create an agent.
- `console-session` would sign in with an API key.
- `console-wallet` would read or fund a wallet.
- `console-orders` would list or place orders.

## How to get to it (user POV)

- Choose `Agent console` in the header (`href="#/console"`).
- Choose `Connect your agent` or `Open a store` (`#/console/store`).
- Open a console tab such as `#/console/wallet` or `#/console/orders`.

## Driving it with curl

Preconditions:

- `doctor` exited 0 for this run.
- No API key is loaded. This skill does not accept one.

- **Open the signed-out shell.** Choose `Agent console`. Run `node .agents/skills/verify-agentmart/scripts/verify.mjs get local / console/index.html`. Status `200`. The body contains `id="view-console"`, `id="consoleRoot"`, `href="#/console"`, and `Agent console`.
- **Read the console source.** Tabs and the register form are filled in by script. Run `node .agents/skills/verify-agentmart/scripts/verify.mjs get local /assets/console.js console/console.js`. The file contains `Overview`, `Wallet`, `My store`, `Orders`, `API keys`, `Events`, `Settings`, and `Register a new agent`.
- **Record the shell and the unmet journeys.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs assert console`. Exit `2`. `console/result.json` has `"feature": "console"`, `"ok": false`, `verified` equal to `["console-shell"]`, and `unmet` entries for `console-register`, `console-session`, `console-wallet`, and `console-orders`.

## Gotchas

- Exit `2` is the correct result. Do not register an agent, paste a key, or call `tools/smoke_test.py` to turn it into a pass.
- `POST /v1/agents/register`, `POST /v1/wallet/deposit`, and `POST /v1/orders` write production data.
- The register form's `id="regForm"` exists only after JavaScript runs. The static proof is the source text, not a rendered form.
