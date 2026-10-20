---
name: verify-agentmart
description: Drive the AgentMart static web console and its public read-only API with curl. Use to prove the home, marketplace, listing, store, developers, or signed-out console surfaces, including launch, doctor, evidence, and cleanup.
---

# Verify AgentMart

The console in `web/` is a static single-page app. Hash routes are not sent to the server. This skill serves that directory, curls the document and assets a browser would load, and GETs the public API those pages call. It does not register agents, place orders, deposit, or deploy.

Run every command from the repository root. The harness is `.agents/skills/verify-agentmart/scripts/verify.mjs`. Feature recipes live in `features/`. Drive the feature file that matches the behavior under test. A pass on one feature does not cover the others.

## Launch

One server at a time. A second `launch` fails while the current server is still alive. Local servers could bind different ports, and `web/` has no database, but the public API is shared. Do not drive two runs at once.

```bash
node .agents/skills/verify-agentmart/scripts/verify.mjs launch
```

That starts:

```bash
python3 -m http.server <port> --bind 127.0.0.1 --directory web
```

The port starts at `4173` unless `AGENTMART_VERIFY_PORT` is set. Ready means `GET /` returns 200 from this checkout, not merely that a process exists. The command prints `run_id`, `port`, `pid`, and `evidence`.

State is `/tmp/agentmart-verify-runs/<run_id>.json`. The current id is `/tmp/agentmart-verify-runs/current`. Evidence is `/tmp/agentmart-verify-evidence/<run_id>/`. Set `AGENTMART_VERIFY_RUN` to target a run that is not current.

There is no migration and no seed. Listings come from the public API. If a journey needs a listing and the API returns none, that journey fails. Do not create one.

## Doctor

Run this before driving, and again whenever a request looks wrong.

```bash
node .agents/skills/verify-agentmart/scripts/verify.mjs doctor
```

Doctor passes only when all of these are true:

- The recorded pid is alive, its command line is the `http.server` this launch started, its cwd is this repo, and `/proc/<pid>/net/tcp` shows it listening on the recorded port.
- `GET /` is 200 and the body bytes equal `web/index.html`, including `id="view-home"`.
- `GET /assets/config.js` is 200, the bytes equal `web/assets/config.js`, and it assigns `window.AGENTMART_API` to an `https://` URL.

The report is `doctor.json` in the evidence folder. Doctor does not call the API and does not check a key. The console's public pages have no local login.

## Drive

Use the feature file for the journey. Fixed paths:

```bash
node .agents/skills/verify-agentmart/scripts/verify.mjs get local <path> <evidence-relative-file>
node .agents/skills/verify-agentmart/scripts/verify.mjs get api <path> <evidence-relative-file>
node .agents/skills/verify-agentmart/scripts/verify.mjs assert <feature>
```

`drive <feature>` runs that feature's whole recipe. `drive listing discover` and `drive store discover` only resolve an id or slug. `drive listing fetch` and `drive store fetch` then load it.

`get` is GET-only. It refuses a request body, a redirect, and any path outside its allowlist. Local paths are the console document, `llms.txt`, and the asset files the pages load. API paths are the public reads named in the feature files: service descriptor, stats, categories, catalog, listing search, one listing, one store, reviews, `llms.txt`, OpenAPI, and the manifest. The API host is parsed from the served `config.js` and must be `https` on a `supabase.co` host with path `/functions/v1/api`. `?api=` is a browser override. Curl does not apply it.

`assert` reads saved bodies and writes `<feature>/result.json`. Exit `0` is a pass. Exit `2` means an unmet precondition, recorded under `unmet`. Do not report that feature as verified. Exit `1` is a failed check.

The signed-in console, registration, deposits, and checkout are unmet on purpose. Do not satisfy them with `tools/smoke_test.py` or any POST.

## Evidence

Each `get` writes the body, `<file>.headers`, `<file>.status`, and `<file>.url`. `assert` writes `<feature>/result.json` with the feature id, the entry points exercised, and one check per sub-feature. Doctor writes `doctor.json`. Launch writes `launch.json` and `server.log`.

A proof shows the request and the resulting state: the status file plus the body field the check names. Hashes in `doctor.json` show the served console is this checkout. API URL files show the host came from `config.js`.

## Cleanup

```bash
node .agents/skills/verify-agentmart/scripts/verify.mjs cleanup
```

Cleanup sends `SIGTERM`, then `SIGKILL`, to the process group of the recorded pid. It does that only when the pid still matches the server this run started. It deletes the run's state file and the current pointer when that pointer is this run. It leaves `/tmp/agentmart-verify-evidence/<run_id>/` in place. If that folder is gone, cleanup fails.

## Helpers

The harness is executable and is the only helper:

```bash
node .agents/skills/verify-agentmart/scripts/verify.mjs launch
node .agents/skills/verify-agentmart/scripts/verify.mjs doctor
node .agents/skills/verify-agentmart/scripts/verify.mjs get local / marketplace/index.html
node .agents/skills/verify-agentmart/scripts/verify.mjs get api /v1/stats home/api-stats.json
node .agents/skills/verify-agentmart/scripts/verify.mjs assert marketplace
node .agents/skills/verify-agentmart/scripts/verify.mjs drive marketplace
node .agents/skills/verify-agentmart/scripts/verify.mjs cleanup
```

`drive` without a step runs every `get` and `assert` in that feature file. Prefer the feature file's commands when you need a single sub-feature.

## Maintenance

When the console routes or public GET shapes change, update the matching file under `features/` and the allowlist in the harness together. `/maintain-verification-skill` is the loop for that.
