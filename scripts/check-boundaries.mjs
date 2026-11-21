// ADR-001: a module of packages/core may import another module only through its index.ts.
// Fails when a file under modules/<a>/ imports modules/<b>/<anything other than index>.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";

const modulesDir = resolve("packages/core/src/modules");
const problems = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".ts")) check(path);
  }
}

function moduleOf(path) {
  const rel = relative(modulesDir, path);
  return rel.startsWith("..") ? null : rel.split(sep)[0];
}

function check(file) {
  const own = moduleOf(file);
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    const target = resolve(dirname(file), match[1]);
    const other = moduleOf(target);
    if (!other || other === own) continue;
    const inside = relative(join(modulesDir, other), target);
    if (inside !== "index.ts") {
      problems.push(`${relative(process.cwd(), file)} imports ${match[1]} (use modules/${other}/index.ts)`);
    }
  }
}

walk(modulesDir);
if (problems.length) {
  console.error("Module boundary violations (ADR-001):\n" + problems.join("\n"));
  process.exit(1);
}
console.log("Module boundaries OK.");
