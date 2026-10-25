// Lint: syntax-check every JS/MJS/CJS file, then a few text rules.
import { readFileSync } from "node:fs";
import path from "node:path";
import { listJsFiles, repoRoot, syntaxCheck } from "./jsfiles.mjs";

const root = repoRoot();
const files = listJsFiles(root);
const failures = [];

for (const failure of syntaxCheck(files)) {
  failures.push(`${path.relative(root, failure.file)}: ${failure.detail}`);
}

for (const file of files) {
  const rel = path.relative(root, file);
  const text = readFileSync(file, "utf8");
  if (text.includes("\0")) failures.push(`${rel}: NUL byte`);
  if (/^(?:<{7}|={7}|>{7})/m.test(text)) failures.push(`${rel}: conflict marker`);
  const breakpoint = "debug" + "ger";
  if (new RegExp(`\\b${breakpoint}\\b`).test(text)) failures.push(`${rel}: ${breakpoint} statement`);
}

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.private !== true) failures.push("package.json: private must be true");
if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
  failures.push("package.json: runtime dependencies are not allowed");
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(`lint ok (${files.length} files)`);
