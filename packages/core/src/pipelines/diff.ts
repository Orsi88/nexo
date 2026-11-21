import { LineCounter, parseDocument } from "yaml";

// Diferença linha a linha entre o YAML atual e o proposto (incremento 4): é o que a pessoa vê e
// confirma antes de gravar (RN-043). Algoritmo da maior subsequência comum, suficiente para
// arquivos de pipeline (centenas de linhas); acima do limite, mostra só "tudo mudou".

export interface DiffLine {
  kind: "same" | "add" | "remove" | "skip";
  text: string;
  /** Número da linha no arquivo antigo / novo (1 = primeira). */
  oldLine?: number;
  newLine?: number;
}

export interface DefinitionDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  changed: boolean;
}

const MAX_LINES = 4000;
const CONTEXT = 3;

const splitLines = (text: string) => (text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

export function lineDiff(before: string, after: string): DefinitionDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  let full: DiffLine[];
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    full = [...a.map((text, i): DiffLine => ({ kind: "remove", text, oldLine: i + 1 })), ...b.map((text, i): DiffLine => ({ kind: "add", text, newLine: i + 1 }))];
  } else {
    // Tabela de LCS de trás para frente; depois anda do começo escolhendo o caminho.
    const n = a.length;
    const m = b.length;
    const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    full = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        full.push({ kind: "same", text: a[i]!, oldLine: i + 1, newLine: j + 1 });
        i++;
        j++;
      } else if (j < m && (i >= n || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) {
        full.push({ kind: "add", text: b[j]!, newLine: j + 1 });
        j++;
      } else {
        full.push({ kind: "remove", text: a[i]!, oldLine: i + 1 });
        i++;
      }
    }
  }
  const added = full.filter((l) => l.kind === "add").length;
  const removed = full.filter((l) => l.kind === "remove").length;
  // Só as mudanças com algumas linhas de contexto; o resto vira um marcador "linhas iguais".
  const keep = full.map(() => false);
  full.forEach((l, k) => {
    if (l.kind === "same") return;
    for (let d = Math.max(0, k - CONTEXT); d <= Math.min(full.length - 1, k + CONTEXT); d++) keep[d] = true;
  });
  const lines: DiffLine[] = [];
  let skipped = 0;
  full.forEach((l, k) => {
    if (keep[k]) {
      if (skipped) lines.push({ kind: "skip", text: `${skipped} ${skipped === 1 ? "linha igual" : "linhas iguais"}` });
      skipped = 0;
      lines.push(l);
    } else skipped++;
  });
  if (skipped && lines.length) lines.push({ kind: "skip", text: `${skipped} ${skipped === 1 ? "linha igual" : "linhas iguais"}` });
  return { lines, added, removed, changed: added + removed > 0 };
}

/** Problemas de sintaxe do YAML, com a linha. Não valida o esquema do provedor (isso é dele). */
export function yamlProblems(content: string): string[] {
  if (!content.trim()) return ["O arquivo está vazio."];
  const lines = new LineCounter();
  const doc = parseDocument(content, { prettyErrors: false, uniqueKeys: true, lineCounter: lines });
  const problems = doc.errors.slice(0, 10).map((e) => {
    const line = lines.linePos(e.pos[0]).line;
    return `${line ? `Linha ${line}: ` : ""}${e.message.split("\n")[0]}`;
  });
  if (!problems.length) {
    const value = doc.toJS() as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) problems.push("O arquivo precisa ser um mapa YAML (chaves como trigger, jobs, steps).");
  }
  return problems;
}
