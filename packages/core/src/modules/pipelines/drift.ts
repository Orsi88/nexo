import type { ParameterSpec } from "@painel/contracts";

// Compara os parâmetros do manifesto com os que a definição do provedor declara.
// "error" impede salvar: o provedor recusaria o disparo (S1, achado 4: o Azure responde
// "Unexpected parameter" e "not a valid Boolean"). "info" só avisa.

export interface ParameterProblem {
  parameter: string;
  severity: "error" | "info";
  message: string;
}

const baseType = (p: ParameterSpec) => (p.type === "enum" ? "string" : p.type);

export function compareWithProvider(manifest: readonly ParameterSpec[], provider: readonly ParameterSpec[]): ParameterProblem[] {
  const problems: ParameterProblem[] = [];
  const declared = new Map(provider.map((p) => [p.name, p]));
  const mine = new Map(manifest.map((p) => [p.name, p]));

  for (const p of manifest) {
    const external = declared.get(p.name);
    if (!external) {
      problems.push({ parameter: p.name, severity: "error", message: "a pipeline do provedor não declara este parâmetro" });
      continue;
    }
    // Enum na plataforma sobre string no provedor é permitido: a plataforma restringe mais.
    const compatible = baseType(p) === baseType(external) && !(external.type === "enum" && p.type !== "enum");
    if (!compatible) {
      problems.push({ parameter: p.name, severity: "error", message: `tipo ${p.type} incompatível com ${external.type} do provedor` });
      continue;
    }
    if (external.type === "enum" && p.type === "enum") {
      const outside = p.options.filter((o) => !external.options.includes(o));
      if (outside.length) {
        problems.push({ parameter: p.name, severity: "error", message: `opções que o provedor não aceita: ${outside.join(", ")}` });
      }
    }
  }

  for (const external of provider) {
    if (mine.has(external.name)) continue;
    problems.push(
      external.required
        ? { parameter: external.name, severity: "error", message: "obrigatório no provedor e ausente no manifesto" }
        : { parameter: external.name, severity: "info", message: "não aparece no formulário; o provedor usa o valor padrão" },
    );
  }
  return problems;
}
