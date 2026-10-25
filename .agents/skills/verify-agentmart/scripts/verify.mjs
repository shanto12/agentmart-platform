#!/usr/bin/env node
// Read-only verification harness for the AgentMart static console.
// Starts python's http.server for this checkout's web/ directory, curls that
// server, and GETs the public API base named in web/assets/config.js.
// It never sends a request body and never uses a method other than GET.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const RUNS = "/tmp/agentmart-verify-runs";
const EVIDENCE_ROOT = "/tmp/agentmart-verify-evidence";
const LOCAL_PATHS = new Set([
  "/",
  "/index.html",
  "/favicon.svg",
  "/llms.txt",
  "/robots.txt",
  "/assets/app.css",
  "/assets/config.js",
  "/assets/console.js",
  "/assets/core.js",
  "/assets/developers.js",
  "/assets/views.js",
]);

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function runIdFromEnvOrCurrent() {
  if (process.env.AGENTMART_VERIFY_RUN) return process.env.AGENTMART_VERIFY_RUN.trim();
  const pointer = path.join(RUNS, "current");
  if (!existsSync(pointer)) return "";
  return readFileSync(pointer, "utf8").trim();
}

function runPath(id) {
  return path.join(RUNS, `${id}.json`);
}

function readRun(id) {
  const file = runPath(id);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replace(/\0/g, " ");
  } catch {
    return "";
  }
}

function cwdOf(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return "";
  }
}

function listens(pid, port) {
  let text;
  try {
    text = readFileSync(`/proc/${pid}/net/tcp`, "utf8");
  } catch {
    return false;
  }
  const portHex = port.toString(16).toLowerCase();
  return text.split("\n").some((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts[3] !== "0A") return false;
    const local = (parts[1] || "").toLowerCase();
    return local.endsWith(`:${portHex}`);
  });
}

function owned(state) {
  if (!state || !Number.isInteger(state.pid) || state.pid <= 1) return false;
  if (!alive(state.pid)) return false;
  const cmd = cmdline(state.pid);
  return cmd.includes("http.server")
    && cmd.includes(String(state.port))
    && cmd.includes("--directory")
    && cwdOf(state.pid) === state.repo
    && listens(state.pid, state.port);
}

function requireOwned() {
  const id = runIdFromEnvOrCurrent();
  if (!id) fail("no verify run is current. launch first.");
  const state = readRun(id);
  if (!state) fail(`missing state for ${id}`);
  if (!owned(state)) fail(`run ${id} is not a live server started by this skill`);
  return state;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function curl(url, dest, proto) {
  mkdirSync(path.dirname(dest), { recursive: true });
  const headers = `${dest}.headers`;
  const statusFile = `${dest}.status`;
  const result = spawnSync("curl", [
    "--silent",
    "--show-error",
    "--get",
    "--proto",
    proto,
    "--max-redirs",
    "0",
    "--connect-timeout",
    "5",
    "--max-time",
    "20",
    "--max-filesize",
    "2000000",
    "-D",
    headers,
    "-o",
    dest,
    "-w",
    "%{http_code}",
    url,
  ], { encoding: "utf8" });
  if (result.error) fail(`curl failed to start: ${result.error.message}`);
  const status = (result.stdout || "").trim();
  writeFileSync(statusFile, `${status}\n`);
  writeFileSync(`${dest}.url`, `${url}\n`);
  if (result.status !== 0) {
    fail(`curl ${url} exited ${result.status}: ${(result.stderr || "").trim()}`);
  }
  return { status, dest };
}

function localUrl(state, pathname) {
  return `http://127.0.0.1:${state.port}${pathname}`;
}

function assertLocalPath(pathname) {
  if (!LOCAL_PATHS.has(pathname)) fail(`local path is not in the read-only allowlist: ${pathname}`);
}

function assertApiPath(input) {
  const url = new URL(input, "https://api.invalid");
  if (url.username || url.password || url.hash) fail("API path must not include credentials or a hash");
  const keys = [...url.searchParams.keys()];
  const unique = new Set(keys);
  if (unique.size !== keys.length) fail("repeated API query keys are not allowed");
  const query = Object.fromEntries(url.searchParams.entries());
  const allowQuery = (names, checks) => {
    for (const key of keys) {
      if (!names.includes(key)) fail(`query ${key} is not allowed on ${url.pathname}`);
    }
    checks();
  };
  const limitOk = () => {
    if (query.limit === undefined) return;
    if (!/^[0-9]{1,2}$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 20) {
      fail("limit must be 1..20");
    }
  };
  const sortOk = (allowed) => {
    if (query.sort !== undefined && !allowed.includes(query.sort)) fail("sort value is not allowed");
  };
  const id = "(?:[A-Za-z0-9_-]{1,64})";
  if (url.pathname === "/v1" || url.pathname === "/v1/stats" || url.pathname === "/v1/categories" || url.pathname === "/llms.txt" || url.pathname === "/v1/openapi.json" || url.pathname === "/.well-known/agentmart.json") {
    allowQuery([], () => {});
    return url.pathname + url.search;
  }
  if (url.pathname === "/v1/listings") {
    allowQuery(["limit", "sort", "q", "kind", "category"], () => {
      limitOk();
      sortOk(["relevance", "price_asc", "price_desc", "newest", "rating"]);
      if (query.kind && !["physical", "digital", "service"].includes(query.kind)) fail("kind is not allowed");
      if (query.q && query.q.length > 200) fail("q is too long");
      if (query.category && !/^[a-z0-9-]{1,60}$/.test(query.category)) fail("category is not a slug");
    });
    return url.pathname + url.search;
  }
  if (url.pathname === "/v1/catalog") {
    allowQuery(["limit"], limitOk);
    return url.pathname + url.search;
  }
  let match = url.pathname.match(new RegExp(`^/v1/listings/${id}$`));
  if (match) {
    allowQuery([], () => {});
    return url.pathname;
  }
  match = url.pathname.match(new RegExp(`^/v1/listings/${id}/reviews$`));
  if (match) {
    allowQuery(["sort", "limit"], () => {
      limitOk();
      sortOk(["newest", "highest", "lowest"]);
    });
    return url.pathname + url.search;
  }
  match = url.pathname.match(new RegExp(`^/v1/stores/(${id})$`));
  if (match) {
    if (match[1] === "me") fail("GET /v1/stores/me is authenticated");
    allowQuery([], () => {});
    return url.pathname;
  }
  match = url.pathname.match(new RegExp(`^/v1/stores/(${id})/reviews$`));
  if (match) {
    if (match[1] === "me") fail("authenticated store path");
    allowQuery(["sort", "limit"], () => {
      limitOk();
      sortOk(["newest", "highest", "lowest"]);
    });
    return url.pathname + url.search;
  }
  fail(`API path is not in the read-only allowlist: ${input}`);
}

function publicApiBase(state) {
  const dest = path.join(state.evidence, "config.js");
  const got = curl(localUrl(state, "/assets/config.js"), dest, "=http");
  if (got.status !== "200") fail(`config.js status ${got.status}`);
  const disk = readFileSync(path.join(state.repo, "web/assets/config.js"));
  const served = readFileSync(dest);
  if (!disk.equals(served)) fail("served config.js does not match this checkout");
  const match = served.toString("utf8").match(/window\.AGENTMART_API\s*=\s*"([^"]+)"/);
  if (!match) fail("config.js has no window.AGENTMART_API assignment");
  let url;
  try {
    url = new URL(match[1]);
  } catch {
    fail("window.AGENTMART_API is not a URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) fail("API base must be https and credential-free");
  if (url.pathname.replace(/\/+$/, "") !== "/functions/v1/api") fail("API base path is not /functions/v1/api");
  if (!url.hostname.endsWith(".supabase.co")) fail("API host is not a public Supabase host");
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  writeFileSync(path.join(state.evidence, "api-base.txt"), `${base}\n`);
  return base;
}

function evidenceDest(state, rel) {
  if (!rel || rel.startsWith("/") || rel.split("/").some((part) => part === ".." || part === "")) {
    fail(`evidence path is not relative: ${rel}`);
  }
  const dest = path.resolve(state.evidence, rel);
  if (!dest.startsWith(`${state.evidence}${path.sep}`)) fail("evidence path escapes the run folder");
  return dest;
}

function getLocal(state, pathname, rel) {
  assertLocalPath(pathname);
  const dest = evidenceDest(state, rel);
  const got = curl(localUrl(state, pathname), dest, "=http");
  console.log(`local ${pathname} -> ${got.status} ${rel}`);
  if (got.status !== "200") fail(`local ${pathname} returned ${got.status}`);
}

function getApi(state, apiPath, rel) {
  const allowed = assertApiPath(apiPath);
  const base = publicApiBase(state);
  const dest = evidenceDest(state, rel);
  const got = curl(`${base}${allowed}`, dest, "=https");
  console.log(`api ${allowed} -> ${got.status} ${rel}`);
  if (got.status !== "200") fail(`api ${allowed} returned ${got.status}`);
}

function readText(state, rel) {
  return readFileSync(evidenceDest(state, rel), "utf8");
}

function readJson(state, rel) {
  return JSON.parse(readText(state, rel));
}

function statusOf(state, rel) {
  return readText(state, `${rel}.status`).trim();
}

function urlOf(state, rel) {
  return readText(state, `${rel}.url`).trim();
}

function finiteCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0;
}

function writeResult(state, feature, result, code) {
  const dest = evidenceDest(state, `${feature}/result.json`);
  writeFileSync(dest, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`result ${dest} ok=${result.ok}`);
  process.exit(code);
}

function assertFileStatus(state, rel) {
  if (statusOf(state, rel) !== "200") fail(`${rel} status is not 200`);
}

function assertMarketplace(state) {
  const checks = [];
  const html = readText(state, "marketplace/index.html");
  assertFileStatus(state, "marketplace/index.html");
  const shellOk = html.includes('id="view-market"')
    && html.includes('id="searchForm"')
    && html.includes('id="q"')
    && html.includes('href="#/market"')
    && html.includes('data-nav="market"');
  checks.push({ id: "market-shell", ok: shellOk });

  const config = readText(state, "marketplace/config.js");
  assertFileStatus(state, "marketplace/config.js");
  const configOk = /window\.AGENTMART_API\s*=\s*"https:\/\/[^"]+\/functions\/v1\/api"/.test(config);
  checks.push({ id: "market-config", ok: configOk });

  assertFileStatus(state, "marketplace/api-v1.json");
  const info = readJson(state, "marketplace/api-v1.json");
  const infoUrl = new URL(urlOf(state, "marketplace/api-v1.json"));
  const healthOk = info.name === "AgentMart" && typeof info.version === "string" && infoUrl.pathname.endsWith("/v1");
  checks.push({ id: "market-health", ok: healthOk });

  assertFileStatus(state, "marketplace/api-listings.json");
  const page = readJson(state, "marketplace/api-listings.json");
  const listUrl = new URL(urlOf(state, "marketplace/api-listings.json"));
  const itemsOk = Array.isArray(page.data)
    && (page.next_cursor === null || typeof page.next_cursor === "string")
    && listUrl.searchParams.get("limit") === "12"
    && listUrl.searchParams.get("sort") === "relevance"
    && page.data.every((item) => item && typeof item.id === "string" && typeof item.title === "string" && finiteCount(item.price_cents) && ["physical", "digital", "service"].includes(item.kind));
  checks.push({ id: "market-search", ok: itemsOk, count: Array.isArray(page.data) ? page.data.length : 0 });

  assertFileStatus(state, "marketplace/api-categories.json");
  const cats = readJson(state, "marketplace/api-categories.json");
  const catsOk = Array.isArray(cats.data)
    && cats.data.every((cat) => cat && typeof cat.slug === "string" && finiteCount(cat.listing_count));
  checks.push({ id: "market-categories", ok: catsOk, count: Array.isArray(cats.data) ? cats.data.length : 0 });

  const ok = checks.every((check) => check.ok);
  writeResult(state, "marketplace", {
    feature: "marketplace",
    ok,
    entry_points: ["#/market", "GET /v1", "GET /v1/listings?limit=12&sort=relevance", "GET /v1/categories"],
    checks,
  }, ok ? 0 : 1);
}

function assertHome(state) {
  const html = readText(state, "home/index.html");
  assertFileStatus(state, "home/index.html");
  const shellOk = html.includes('id="view-home"')
    && html.includes('id="homeStats"')
    && html.includes('id="pricing"')
    && html.includes('href="#/home/pricing"')
    && html.includes("buy and sell");
  assertFileStatus(state, "home/api-stats.json");
  const stats = readJson(state, "home/api-stats.json");
  const keys = ["agents", "stores", "active_listings", "orders_completed", "gmv_cents"];
  const statsOk = keys.every((key) => finiteCount(stats[key])) && (stats.mode === "sandbox" || stats.mode === "live");
  const checks = [
    { id: "home-shell", ok: shellOk },
    { id: "home-pricing", ok: html.includes('id="pricing"') && html.includes('href="#/home/pricing"') },
    { id: "home-stats", ok: statsOk },
  ];
  const ok = checks.every((check) => check.ok);
  writeResult(state, "home", {
    feature: "home",
    ok,
    entry_points: ["#/", "#/home/pricing", "GET /v1/stats"],
    checks,
  }, ok ? 0 : 1);
}

function assertListing(state) {
  const html = readText(state, "listing/index.html");
  assertFileStatus(state, "listing/index.html");
  const shellOk = html.includes('id="view-listing"') && html.includes('id="listingRoot"');
  const id = readText(state, "listing/id.txt").trim();
  assertFileStatus(state, "listing/api-listing.json");
  const listing = readJson(state, "listing/api-listing.json");
  const detailUrl = new URL(urlOf(state, "listing/api-listing.json"));
  const detailOk = listing.id === id && typeof listing.title === "string" && finiteCount(listing.price_cents);
  const purchase = listing.purchase || {};
  const hintOk = purchase.endpoint === "POST /v1/orders" && Array.isArray(purchase.required_fields);
  const checks = [
    { id: "listing-shell", ok: shellOk },
    { id: "listing-detail", ok: detailOk && detailUrl.pathname.endsWith(`/listings/${id}`) },
    { id: "listing-purchase-hint", ok: hintOk },
  ];
  const ok = checks.every((check) => check.ok);
  writeResult(state, "listing", {
    feature: "listing",
    ok,
    entry_points: [`#/listing/${id}`, `GET /v1/listings/${id}`],
    checks,
  }, ok ? 0 : 1);
}

function assertStore(state) {
  const html = readText(state, "store/index.html");
  assertFileStatus(state, "store/index.html");
  const shellOk = html.includes('id="view-store"') && html.includes('id="storeRoot"');
  const slug = readText(state, "store/slug.txt").trim();
  assertFileStatus(state, "store/api-store.json");
  const store = readJson(state, "store/api-store.json");
  const storeOk = store.slug === slug && typeof store.name === "string" && Array.isArray(store.listings);
  assertFileStatus(state, "store/api-reviews.json");
  const reviews = readJson(state, "store/api-reviews.json");
  const reviewsOk = Array.isArray(reviews.data) && reviews.rating && finiteCount(reviews.rating.count);
  const checks = [
    { id: "store-shell", ok: shellOk },
    { id: "store-detail", ok: storeOk },
    { id: "store-reviews", ok: reviewsOk },
  ];
  const ok = checks.every((check) => check.ok);
  writeResult(state, "store", {
    feature: "store",
    ok,
    entry_points: [`#/store/${slug}`, `GET /v1/stores/${slug}`],
    checks,
  }, ok ? 0 : 1);
}

function assertDevelopers(state) {
  const html = readText(state, "developers/index.html");
  assertFileStatus(state, "developers/index.html");
  const shellOk = html.includes('id="view-developers"') && html.includes('id="devRoot"') && html.includes('href="#/developers"');
  const source = readText(state, "developers/developers.js");
  assertFileStatus(state, "developers/developers.js");
  const sourceOk = source.includes('id="dev-quickstart"') && source.includes('id="dev-mcp"') && source.includes('id="dev-reference"') && source.includes('href="#/developers/quickstart"');
  const localGuide = readText(state, "developers/llms.txt");
  assertFileStatus(state, "developers/llms.txt");
  const localOk = localGuide.includes("AgentMart") && localGuide.includes("GET /v1/listings");
  assertFileStatus(state, "developers/api-llms.txt");
  const apiGuide = readText(state, "developers/api-llms.txt");
  const apiGuideOk = apiGuide.includes("AgentMart") && apiGuide.includes("/v1/listings");
  assertFileStatus(state, "developers/openapi.json");
  const spec = readJson(state, "developers/openapi.json");
  const specOk = typeof spec.openapi === "string" && spec.openapi.startsWith("3.");
  assertFileStatus(state, "developers/manifest.json");
  const manifest = readJson(state, "developers/manifest.json");
  const manifestOk = manifest.name === "AgentMart" && manifest.mcp && typeof manifest.mcp.url === "string";
  const checks = [
    { id: "dev-shell", ok: shellOk },
    { id: "dev-source", ok: sourceOk },
    { id: "dev-local-llms", ok: localOk },
    { id: "dev-api-docs", ok: apiGuideOk && specOk && manifestOk },
  ];
  const ok = checks.every((check) => check.ok);
  writeResult(state, "developers", {
    feature: "developers",
    ok,
    entry_points: ["#/developers", "#/developers/quickstart", "GET /llms.txt", "GET /v1/openapi.json"],
    checks,
  }, ok ? 0 : 1);
}

function assertConsole(state) {
  const html = readText(state, "console/index.html");
  assertFileStatus(state, "console/index.html");
  const shellHtml = html.includes('id="view-console"') && html.includes('id="consoleRoot"') && html.includes('href="#/console"') && html.includes("Agent console");
  const source = readText(state, "console/console.js");
  assertFileStatus(state, "console/console.js");
  const shellSource = ["Overview", "Wallet", "My store", "Orders", "API keys", "Events", "Settings", "Register a new agent"]
    .every((label) => source.includes(label));
  const unmet = [
    { id: "console-register", reason: "POST /v1/agents/register creates an agent. This skill is read-only." },
    { id: "console-session", reason: "No API key is available, and this skill must not create or accept one." },
    { id: "console-wallet", reason: "Wallet reads and deposits need a signed-in agent. Deposit writes ledger rows." },
    { id: "console-orders", reason: "Order placement writes an escrow hold. This skill does not call POST /v1/orders." },
  ];
  const shellOk = shellHtml && shellSource;
  writeResult(state, "console", {
    feature: "console",
    ok: false,
    verified: shellOk ? ["console-shell"] : [],
    unmet,
    checks: [{ id: "console-shell", ok: shellOk }],
    entry_points: ["#/console"],
  }, shellOk ? 2 : 1);
}

const ASSERTS = {
  marketplace: assertMarketplace,
  home: assertHome,
  listing: assertListing,
  store: assertStore,
  developers: assertDevelopers,
  console: assertConsole,
};

async function launch() {
  mkdirSync(RUNS, { recursive: true });
  const currentId = runIdFromEnvOrCurrent();
  if (!process.env.AGENTMART_VERIFY_RUN && currentId) {
    const current = readRun(currentId);
    if (owned(current)) fail(`run ${currentId} is still live on port ${current.port}. cleanup first.`);
  }
  const runId = `verify-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomBytes(3).toString("hex")}`;
  const evidence = path.join(EVIDENCE_ROOT, runId);
  mkdirSync(evidence, { recursive: true });
  const logFd = openSync(path.join(evidence, "server.log"), "a");
  const preferred = Number(process.env.AGENTMART_VERIFY_PORT || 4173);
  let child = null;
  let port = 0;
  for (let candidate = preferred; candidate < preferred + 30; candidate++) {
    child = spawn("python3", ["-m", "http.server", String(candidate), "--bind", "127.0.0.1", "--directory", "web"], {
      cwd: REPO,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 4000) {
      if (child.exitCode !== null) break;
      const probe = spawnSync("curl", ["--silent", "--show-error", "--get", "--proto", "=http", "--max-redirs", "0", "--max-time", "2", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${candidate}/`], { encoding: "utf8" });
      if ((probe.stdout || "").trim() === "200") {
        ready = true;
        break;
      }
      await delay(100);
    }
    if (ready && owned({ pid: child.pid, port: candidate, repo: REPO })) {
      port = candidate;
      break;
    }
    if (child.exitCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* process already gone */ }
    }
    child = null;
  }
  closeSync(logFd);
  if (!child || !port) fail(`python http.server did not become ready. see ${path.join(evidence, "server.log")}`);
  const state = {
    run_id: runId,
    pid: child.pid,
    port,
    repo: REPO,
    evidence,
    started_at: new Date().toISOString(),
    command: ["python3", "-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", "web"],
  };
  writeFileSync(runPath(runId), `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(path.join(RUNS, "current"), `${runId}\n`);
  writeFileSync(path.join(evidence, "launch.json"), `${JSON.stringify(state, null, 2)}\n`);
  console.log(`run_id=${runId} port=${port} pid=${child.pid} evidence=${evidence}`);
}

function doctor() {
  const state = requireOwned();
  const index = curl(localUrl(state, "/"), path.join(state.evidence, "doctor-index.html"), "=http");
  const servedIndex = readFileSync(path.join(state.evidence, "doctor-index.html"));
  const diskIndex = readFileSync(path.join(state.repo, "web/index.html"));
  const config = curl(localUrl(state, "/assets/config.js"), path.join(state.evidence, "doctor-config.js"), "=http");
  const servedConfig = readFileSync(path.join(state.evidence, "doctor-config.js"));
  const diskConfig = readFileSync(path.join(state.repo, "web/assets/config.js"));
  const report = {
    run_id: state.run_id,
    pid: state.pid,
    port: state.port,
    repo: state.repo,
    index_status: index.status,
    index_matches_checkout: diskIndex.equals(servedIndex),
    index_has_home: servedIndex.toString("utf8").includes('id="view-home"'),
    config_status: config.status,
    config_matches_checkout: diskConfig.equals(servedConfig),
    config_has_api: /window\.AGENTMART_API\s*=\s*"https:\/\//.test(servedConfig.toString("utf8")),
    listens: listens(state.pid, state.port),
  };
  const ok = report.index_status === "200"
    && report.index_matches_checkout
    && report.index_has_home
    && report.config_status === "200"
    && report.config_matches_checkout
    && report.config_has_api
    && report.listens;
  report.ok = ok;
  writeFileSync(path.join(state.evidence, "doctor.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (!ok) fail(`doctor failed. see ${path.join(state.evidence, "doctor.json")}`);
  console.log(`doctor ok run_id=${state.run_id} port=${state.port} pid=${state.pid}`);
}

async function cleanup() {
  const id = runIdFromEnvOrCurrent();
  if (!id) fail("no verify run is current");
  const state = readRun(id);
  const evidence = state?.evidence || path.join(EVIDENCE_ROOT, id);
  if (state && owned(state)) {
    try { process.kill(-state.pid, "SIGTERM"); } catch { /* already gone */ }
    const started = Date.now();
    while (alive(state.pid) && Date.now() - started < 2000) await delay(50);
    if (alive(state.pid)) {
      try { process.kill(-state.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  } else if (state?.pid && alive(state.pid)) {
    console.log(`left pid ${state.pid} alone because it is not the server this run started`);
  }
  rmSync(runPath(id), { force: true });
  const pointer = path.join(RUNS, "current");
  if (existsSync(pointer) && readFileSync(pointer, "utf8").trim() === id) rmSync(pointer, { force: true });
  if (!existsSync(evidence)) fail(`evidence folder is missing: ${evidence}`);
  console.log(`stopped run_id=${id} evidence=${evidence}`);
}

function discoverListing(state) {
  getApi(state, "/v1/listings?limit=1&sort=newest", "listing/sample.json");
  const page = readJson(state, "listing/sample.json");
  const first = page.data && page.data[0];
  if (!first || typeof first.id !== "string") {
    writeResult(state, "listing", {
      feature: "listing",
      ok: false,
      unmet: [{ id: "listing-detail", reason: "GET /v1/listings returned no active listing. Do not create one." }],
      checks: [],
    }, 2);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(first.id)) fail("listing id is not a safe path segment");
  writeFileSync(evidenceDest(state, "listing/id.txt"), `${first.id}\n`);
  console.log(`listing id=${first.id}`);
}

function discoverStore(state) {
  getApi(state, "/v1/listings?limit=1&sort=newest", "store/sample.json");
  const page = readJson(state, "store/sample.json");
  const first = page.data && page.data[0];
  const slug = first && first.store && first.store.slug;
  if (!slug) {
    writeResult(state, "store", {
      feature: "store",
      ok: false,
      unmet: [{ id: "store-detail", reason: "No listing with a store slug was returned. Do not create a store." }],
      checks: [],
    }, 2);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(slug) || slug === "me") fail("store slug is not a public path segment");
  writeFileSync(evidenceDest(state, "store/slug.txt"), `${slug}\n`);
  console.log(`store slug=${slug}`);
}

function drive(state, feature, step) {
  if (feature === "marketplace" && !step) {
    getLocal(state, "/", "marketplace/index.html");
    getLocal(state, "/assets/config.js", "marketplace/config.js");
    getApi(state, "/v1", "marketplace/api-v1.json");
    getApi(state, "/v1/listings?limit=12&sort=relevance", "marketplace/api-listings.json");
    getApi(state, "/v1/categories", "marketplace/api-categories.json");
    assertMarketplace(state);
  } else if (feature === "home" && !step) {
    getLocal(state, "/", "home/index.html");
    getApi(state, "/v1/stats", "home/api-stats.json");
    assertHome(state);
  } else if (feature === "listing" && step === "discover") {
    discoverListing(state);
  } else if (feature === "listing" && step === "fetch") {
    const id = readText(state, "listing/id.txt").trim();
    getLocal(state, "/", "listing/index.html");
    getApi(state, `/v1/listings/${id}`, "listing/api-listing.json");
  } else if (feature === "listing" && !step) {
    discoverListing(state);
    const id = readText(state, "listing/id.txt").trim();
    getLocal(state, "/", "listing/index.html");
    getApi(state, `/v1/listings/${id}`, "listing/api-listing.json");
    assertListing(state);
  } else if (feature === "store" && step === "discover") {
    discoverStore(state);
  } else if (feature === "store" && step === "fetch") {
    const slug = readText(state, "store/slug.txt").trim();
    getLocal(state, "/", "store/index.html");
    getApi(state, `/v1/stores/${slug}`, "store/api-store.json");
    getApi(state, `/v1/stores/${slug}/reviews?sort=newest&limit=10`, "store/api-reviews.json");
  } else if (feature === "store" && !step) {
    discoverStore(state);
    const slug = readText(state, "store/slug.txt").trim();
    getLocal(state, "/", "store/index.html");
    getApi(state, `/v1/stores/${slug}`, "store/api-store.json");
    getApi(state, `/v1/stores/${slug}/reviews?sort=newest&limit=10`, "store/api-reviews.json");
    assertStore(state);
  } else if (feature === "developers" && !step) {
    getLocal(state, "/", "developers/index.html");
    getLocal(state, "/assets/developers.js", "developers/developers.js");
    getLocal(state, "/llms.txt", "developers/llms.txt");
    getApi(state, "/llms.txt", "developers/api-llms.txt");
    getApi(state, "/v1/openapi.json", "developers/openapi.json");
    getApi(state, "/.well-known/agentmart.json", "developers/manifest.json");
    assertDevelopers(state);
  } else if (feature === "console" && !step) {
    getLocal(state, "/", "console/index.html");
    getLocal(state, "/assets/console.js", "console/console.js");
    assertConsole(state);
  } else {
    fail(`unknown drive target: ${feature} ${step || ""}`.trim());
  }
}

const [command, a, b, c] = process.argv.slice(2);
if (command === "launch") {
  await launch();
} else if (command === "doctor") {
  doctor();
} else if (command === "cleanup") {
  await cleanup();
} else if (command === "get" && a === "local") {
  getLocal(requireOwned(), b, c);
} else if (command === "get" && a === "api") {
  getApi(requireOwned(), b, c);
} else if (command === "assert") {
  const fn = ASSERTS[a];
  if (!fn) fail(`unknown feature: ${a}`);
  fn(requireOwned());
} else if (command === "drive") {
  drive(requireOwned(), a, b);
} else {
  fail("usage: verify.mjs launch|doctor|cleanup|get local <path> <evidence>|get api <path> <evidence>|assert <feature>|drive <feature> [discover|fetch]");
}
