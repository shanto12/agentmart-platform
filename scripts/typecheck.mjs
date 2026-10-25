// Typecheck without a TypeScript dependency.
// `tsc` is not installed and this package has no devDependencies.
// Syntax-check every JS file, then check sdk/js/agentmart.mjs against sdk/js/index.d.ts:
// runtime exports and public AgentMart methods must match the declaration file.
import { readFileSync } from "node:fs";
import path from "node:path";
import { listJsFiles, repoRoot, syntaxCheck } from "./jsfiles.mjs";

const root = repoRoot();
const files = listJsFiles(root);
const syntaxFailures = syntaxCheck(files);
if (syntaxFailures.length) {
  for (const failure of syntaxFailures) {
    console.error(`syntax ${path.relative(root, failure.file)}: ${failure.detail}`);
  }
  process.exit(1);
}

const impl = readFileSync(path.join(root, "sdk/js/agentmart.mjs"), "utf8");
const dts = readFileSync(path.join(root, "sdk/js/index.d.ts"), "utf8");

function valueExports(src, declare) {
  const names = new Set();
  const re = declare
    ? /^export\s+declare\s+(?:async\s+)?(?:function|class|const|let|var|enum)\s+([A-Za-z0-9_]+)/gm
    : /^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_]+)/gm;
  for (const match of src.matchAll(re)) names.add(match[1]);
  return { names, hasDefault: /^export\s+default\s+/m.test(src) };
}

function classBody(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`missing ${marker}`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unclosed ${marker}`);
}

function publicMethods(body) {
  const names = new Set();
  const re = /^  (?:static\s+)?(?:async\s+)?(?:\*\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^\n]*>)?\s*\(/gm;
  for (const match of body.matchAll(re)) {
    if (!match[1].startsWith("_")) names.add(match[1]);
  }
  return names;
}

function diff(label, actual, expected) {
  const missing = [...expected].filter((name) => !actual.has(name)).sort();
  const extra = [...actual].filter((name) => !expected.has(name)).sort();
  const problems = [];
  if (missing.length) problems.push(`${label} missing in implementation: ${missing.join(", ")}`);
  if (extra.length) problems.push(`${label} missing in index.d.ts: ${extra.join(", ")}`);
  return problems;
}

const implExports = valueExports(impl, false);
const dtsExports = valueExports(dts, true);
const problems = [
  ...diff("value export", implExports.names, dtsExports.names),
  ...diff(
    "AgentMart method",
    publicMethods(classBody(impl, "export class AgentMart")),
    publicMethods(classBody(dts, "export declare class AgentMart")),
  ),
];
if (implExports.hasDefault !== dtsExports.hasDefault) problems.push("default export mismatch");

if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}

console.log(`typecheck ok (${files.length} files, sdk surface matches index.d.ts)`);
