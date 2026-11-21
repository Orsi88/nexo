import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { classifyOutcome, FileArtifactStore, isZip, readZip } from "../src/index.ts";
import { makeZip } from "./zip-fixture.ts";

describe("leitor de zip", () => {
  it("lê arquivos guardados e comprimidos, e ignora pastas", () => {
    const zip = makeZip([
      { name: "relatorio/", data: "" },
      { name: "relatorio/junit.xml", data: "<testsuites/>" },
      { name: "relatorio/grande.json", data: "x".repeat(10_000), deflate: true },
    ]);
    expect(isZip(zip)).toBe(true);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["relatorio/junit.xml", "relatorio/grande.json"]);
    expect(entries[0]!.read().toString()).toBe("<testsuites/>");
    expect(entries[1]!.read().toString()).toBe("x".repeat(10_000));
  });

  it("corta a descompactação que passa do tamanho declarado (zip bomb)", () => {
    const zip = makeZip([{ name: "bomba.json", data: Buffer.alloc(5_000_000), deflate: true, declaredSize: 100 }]);
    expect(() => readZip(zip)[0]!.read()).toThrow(/maior que o declarado/);
  });

  it("respeita os limites de quantidade e de tamanho", () => {
    const zip = makeZip([
      { name: "a.xml", data: "a".repeat(100) },
      { name: "b.xml", data: "b".repeat(100) },
    ]);
    expect(() => readZip(zip, { maxEntries: 1, maxEntryBytes: 1000, maxTotalBytes: 1000 })).toThrow(/arquivos demais/);
    expect(() => readZip(zip, { maxEntries: 10, maxEntryBytes: 50, maxTotalBytes: 1000 })[0]!.read()).toThrow(/grande demais/);
    const total = readZip(zip, { maxEntries: 10, maxEntryBytes: 1000, maxTotalBytes: 150 });
    total[0]!.read();
    expect(() => total[1]!.read()).toThrow(/passa do limite/);
  });

  it("recusa o que não é zip", () => {
    expect(isZip(Buffer.from("<testsuites/>"))).toBe(false);
    expect(() => readZip(Buffer.alloc(100))).toThrow(/diretório central/);
  });
});

describe("armazenamento de artefatos em pasta", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("guarda, lê e apaga; recusa chaves que saem da pasta", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexo-artefatos-"));
    dirs.push(dir);
    const store = new FileArtifactStore(dir);
    await store.put("org/exec/a.zip", Buffer.from("conteúdo"));
    expect((await store.get("org/exec/a.zip"))?.toString()).toBe("conteúdo");
    expect(await store.get("org/exec/nao-existe.zip")).toBeUndefined();
    await store.delete("org/exec/a.zip");
    expect(await store.get("org/exec/a.zip")).toBeUndefined();
    for (const bad of ["../fora.zip", "org/../../fora", "/absoluto", "org//x", "C:\\x", "org/./x"]) {
      await expect(store.put(bad, Buffer.from("x"))).rejects.toThrow(/inválida|fora/);
    }
  });
});

describe("classificação do resultado (RN-011, RN-012)", () => {
  it("sem relatório é ausência explícita; falha sem relatório é de infraestrutura", () => {
    expect(classifyOutcome({ status: "failed", reports: [], failedTests: 0, artifactErrors: 0 })).toEqual({ reportStatus: "missing", failureKind: "infrastructure" });
    expect(classifyOutcome({ status: "succeeded", reports: [], failedTests: 0, artifactErrors: 0 })).toEqual({ reportStatus: "missing", failureKind: "none" });
  });

  it("falha com teste falhando é falha de teste", () => {
    expect(classifyOutcome({ status: "failed", reports: ["processed"], failedTests: 3, artifactErrors: 0 })).toEqual({ reportStatus: "available", failureKind: "test" });
  });

  it("falha com todos os testes passando não é culpa dos testes", () => {
    expect(classifyOutcome({ status: "failed", reports: ["processed"], failedTests: 0, artifactErrors: 0 }).failureKind).toBe("infrastructure");
  });

  it("falha por threshold do k6 fica explícita, sem virar infraestrutura (CA-045)", () => {
    expect(classifyOutcome({ status: "failed", reports: ["processed"], failedTests: 0, artifactErrors: 0, failedThresholds: 1 }).failureKind).toBe("threshold");
    // Teste funcional falhando tem prioridade: é a causa mais específica.
    expect(classifyOutcome({ status: "failed", reports: ["processed"], failedTests: 2, artifactErrors: 0, failedThresholds: 1 }).failureKind).toBe("test");
    // Execução que passou não vira falha só porque um threshold aparece no resumo.
    expect(classifyOutcome({ status: "succeeded", reports: ["processed"], failedTests: 0, artifactErrors: 0, failedThresholds: 1 }).failureKind).toBe("none");
  });

  it("problemas parciais e relatórios só inválidos", () => {
    expect(classifyOutcome({ status: "succeeded", reports: ["processed", "failed"], failedTests: 0, artifactErrors: 0 }).reportStatus).toBe("partial");
    expect(classifyOutcome({ status: "succeeded", reports: ["processed"], failedTests: 0, artifactErrors: 1 }).reportStatus).toBe("partial");
    expect(classifyOutcome({ status: "succeeded", reports: ["partial"], failedTests: 0, artifactErrors: 0 }).reportStatus).toBe("partial");
    expect(classifyOutcome({ status: "failed", reports: ["failed"], failedTests: 0, artifactErrors: 0 })).toEqual({ reportStatus: "invalid", failureKind: "infrastructure" });
    expect(classifyOutcome({ status: "unknown", reports: [], failedTests: 0, artifactErrors: 0 }).failureKind).toBe("unknown");
  });
});
