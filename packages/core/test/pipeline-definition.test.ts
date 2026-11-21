import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DomainError, lineDiff, PIPELINE_TEMPLATES, renderTemplate, yamlProblems } from "../src/index.ts";

describe("diferença do YAML", () => {
  it("mostra só o que mudou, com contexto, e conta linhas", () => {
    const before = Array.from({ length: 20 }, (_, i) => `linha${i + 1}: ${i + 1}`).join("\n");
    const after = before.replace("linha10: 10", "linha10: dez") + "\nnova: sim";
    const diff = lineDiff(before, after);
    expect(diff).toMatchObject({ added: 2, removed: 1, changed: true });
    expect(diff.lines.filter((l) => l.kind !== "same" && l.kind !== "skip").map((l) => `${l.kind}:${l.text}`)).toEqual([
      "remove:linha10: 10",
      "add:linha10: dez",
      "add:nova: sim",
    ]);
    expect(diff.lines[0]).toEqual({ kind: "skip", text: "6 linhas iguais" });
  });

  it("igual não é mudança", () => {
    expect(lineDiff("a: 1\n", "a: 1").changed).toBe(false);
  });
});

describe("validação do YAML", () => {
  it("aponta a linha do erro de sintaxe", () => {
    expect(yamlProblems("a: 1\nb: [1, 2\n")[0]).toMatch(/^Linha \d+:/);
    expect(yamlProblems("a: 1\na: 2\n").length).toBe(1);
    expect(yamlProblems("- só uma lista\n")).toEqual(["O arquivo precisa ser um mapa YAML (chaves como trigger, jobs, steps)."]);
    expect(yamlProblems("trigger: none\nsteps: []\n")).toEqual([]);
  });
});

describe("modelos de pipeline", () => {
  for (const provider of ["azure-devops", "github"] as const) {
    for (const t of PIPELINE_TEMPLATES) {
      it(`${t.name} gera YAML válido para ${provider}, publicando o relatório`, () => {
        const values = Object.fromEntries(t.fields.filter((f) => f.required && !f.default).map((f) => [f.key, "make test"]));
        const { content, path } = renderTemplate(provider, t.id, "Testes do Portal", { ...values, withMode: true, schedule: "0 6 * * 1-5" });
        expect(yamlProblems(content)).toEqual([]);
        expect(content).toContain(provider === "github" ? "upload-artifact" : "PublishPipelineArtifact");
        expect(path).toBe(provider === "github" ? ".github/workflows/testes-do-portal.yml" : "pipelines/testes-do-portal.yml");
      });
    }
  }

  it("a escolha de suíte vira parâmetro escolhido na hora de executar", () => {
    const az = parse(renderTemplate("azure-devops", "playwright", "E2E", { withMode: true }).content);
    expect(az.parameters[0]).toMatchObject({ name: "suite", default: "regressao", values: ["regressao", "smoke"] });
    const gh = parse(renderTemplate("github", "playwright", "E2E", { withMode: true }).content);
    expect(gh.on.workflow_dispatch.inputs.suite).toMatchObject({ type: "choice", options: ["regressao", "smoke"] });
  });

  it("máquina própria vira pool por nome; máquina do provedor vira imagem", () => {
    expect(parse(renderTemplate("azure-devops", "playwright", "E2E", { agent: "maquina-testes" }).content).pool).toEqual({ name: "maquina-testes" });
    expect(parse(renderTemplate("azure-devops", "playwright", "E2E", {}).content).pool).toEqual({ vmImage: "ubuntu-latest" });
  });

  it("valor com aspas e dois-pontos continua texto (não injeta estrutura)", () => {
    const cmd = 'npm test -- --grep "login: ok" # x';
    const doc = parse(renderTemplate("github", "command", "Livre", { testCommand: cmd, reportPath: "out" }).content);
    expect(doc.jobs.testes.steps.find((s: { name?: string }) => s.name === "Rodar testes").run).toBe(cmd);
  });

  it("recusa valor em várias linhas, agenda inválida e campo obrigatório vazio", () => {
    expect(() => renderTemplate("github", "command", "x", { testCommand: "a\nb", reportPath: "r" })).toThrow(DomainError);
    expect(() => renderTemplate("github", "playwright", "x", { schedule: "todo dia" })).toThrow(/cron/);
    expect(() => renderTemplate("github", "command", "x", { reportPath: "r" })).toThrow(/Comando dos testes/);
  });
});
