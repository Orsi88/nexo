// Barreira contra dados de cliente ou pessoais no repositório (regra do projeto: "nada de credenciais
// em código, manifestos, logs ou testes"; nomes reais de empresa, máquina, versão ou pessoa também não).
//
// Lê os termos proibidos de `.sensitive-words` (um por linha; "#" comenta). Esse arquivo fica só na
// máquina de quem desenvolve e NUNCA vai para o git: senão a própria lista revelaria os nomes.
// Sem o arquivo, a verificação avisa e passa (ex.: no CI). Ignora node_modules, dist, .git e os
// arquivos locais (.env, .mcp.json, .sensitive-words).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(".");
const listFile = join(root, ".sensitive-words");
if (!existsSync(listFile)) {
  console.log("Dados sensíveis: sem .sensitive-words nesta máquina; verificação pulada.");
  process.exit(0);
}

const terms = readFileSync(listFile, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);
const SKIP_FILES = new Set([".env", ".mcp.json", ".sensitive-words"]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|zip|pdf)$/i;
const problems = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(path);
      continue;
    }
    if (SKIP_FILES.has(entry) || BINARY.test(entry)) continue;
    const text = readFileSync(path, "utf8").toLowerCase();
    for (const term of terms) {
      if (text.includes(term.toLowerCase())) problems.push(`${relative(root, path)}: contém um termo de .sensitive-words`);
    }
  }
}

walk(root);
if (problems.length) {
  // Não imprime o termo: o log do CI ou do terminal também não deve repetir o dado.
  console.error("Dados sensíveis encontrados (troque por um exemplo fictício):\n" + [...new Set(problems)].join("\n"));
  process.exit(1);
}
console.log(`Dados sensíveis: nenhum dos ${terms.length} termos encontrado.`);
