import type { ParameterProblem, ParameterSpec } from "./types.ts";

// Cópia da regra de packages/core (modules/pipelines/drift.ts) só para o modo demonstração.
// Com a API no ar, as diferenças vêm calculadas pelo servidor.

const baseType = (p: ParameterSpec) => (p.type === "enum" ? "string" : p.type);

export function compareWithProvider(manifest: readonly ParameterSpec[], provider: readonly ParameterSpec[]): ParameterProblem[] {
  const problems: ParameterProblem[] = [];
  const declared = new Map(provider.map((p) => [p.name, p]));
  const mine = new Set(manifest.map((p) => p.name));
  for (const p of manifest) {
    const external = declared.get(p.name);
    if (!external) problems.push({ parameter: p.name, severity: "error", message: "a pipeline do provedor não declara este parâmetro" });
    else if (baseType(p) !== baseType(external)) {
      problems.push({ parameter: p.name, severity: "error", message: `tipo ${p.type} incompatível com ${external.type} do provedor` });
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
