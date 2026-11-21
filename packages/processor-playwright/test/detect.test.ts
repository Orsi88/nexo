import { describe, expect, it } from "vitest";
import { ProcessorRegistry } from "@painel/processor-sdk";
import { playwrightHtmlProcessor, playwrightJsonProcessor } from "../src/index.ts";
import { junitXmlProcessor } from "@painel/processor-junit";
import { k6SummaryProcessor } from "@painel/processor-k6";

const bytes = (s: string) => new TextEncoder().encode(s);

function registry() {
  const r = new ProcessorRegistry();
  for (const p of [playwrightJsonProcessor, playwrightHtmlProcessor, junitXmlProcessor, k6SummaryProcessor]) r.register(p);
  return r;
}

describe("seleção de processador por conteúdo", () => {
  it("reconhece JSON do Playwright", () => {
    const head = bytes('{"config":{"rootDir":"/x"},"suites":[]}');
    expect(registry().select({ name: "results.json" }, head)?.id).toBe("playwright-json@1");
  });

  it("reconhece JUnit XML com declaração XML", () => {
    const head = bytes('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="x">');
    expect(registry().select({ name: "junit.xml" }, head)?.id).toBe("junit-xml@1");
  });

  it("reconhece resumo do k6 como desempenho, não como funcional", () => {
    const head = bytes('{"root_group":{},"metrics":{"http_req_duration":{}}}');
    const selected = registry().select({ name: "summary.json" }, head);
    expect(selected?.id).toBe("k6-summary@1");
    expect(selected?.category).toBe("performance");
  });

  it("não escolhe nenhum processador para formato desconhecido (artefato fica preservado)", () => {
    expect(registry().select({ name: "notas.txt" }, bytes("qualquer coisa"))).toBeUndefined();
  });

  it("relatório vazio vira falha de leitura, sem inventar resultados", async () => {
    const output = await junitXmlProcessor.process(new Blob([]).stream(), {
      organizationId: "o",
      executionId: "e",
      artifactId: "a",
      correlationId: "c",
    });
    expect(output).toMatchObject({ status: "failed", records: [] });
  });
});
