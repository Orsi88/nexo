import { describe, expect, it } from "vitest";
import { extractSystemVersion, PipelineManifestSchema, type SystemUnderTest } from "../src/index.ts";

// Versão do sistema em teste lida da execução (número, tags, parâmetros), conforme o manifesto.
// O exemplo de número vem do spike S1, achado 7: "20250115.1-master-20250114.18'" (com o apóstrofo).

const FROM_RUN_NUMBER: SystemUnderTest = {
  name: "Sistema Exemplo",
  parts: [
    { key: "distribuicao", label: "Distribuição", source: "runNumber", pattern: "^[^-]+-(?<value>.+)-\\d{8}\\.\\d+$" },
    { key: "pacote", label: "Pacote", source: "runNumber", pattern: "-(?<value>\\d{8}\\.\\d+)$" },
  ],
};

describe("extractSystemVersion", () => {
  it("separa distribuição e pacote do número da execução e ignora a aspa solta", () => {
    expect(extractSystemVersion(FROM_RUN_NUMBER, { runNumber: "20250115.1-master-20250114.18'" })).toEqual({
      system: "Sistema Exemplo",
      full: "master · 20250114.18",
      parts: [
        { key: "distribuicao", label: "Distribuição", value: "master" },
        { key: "pacote", label: "Pacote", value: "20250114.18" },
      ],
      missing: [],
    });
  });

  it("lê de tag com prefixo e de parâmetro", () => {
    const sut: SystemUnderTest = {
      name: "Sistema Exemplo",
      parts: [
        { key: "distribuicao", label: "Distribuição", source: "parameter", parameter: "branchApp" },
        { key: "pacote", label: "Pacote", source: "tag", tagPrefix: "sistema-" },
      ],
    };
    const v = extractSystemVersion(sut, { tags: ["noturno", "sistema-20250114.18"], parameters: { branchApp: "release/7.2" } });
    expect(v?.full).toBe("release/7.2 · 20250114.18");
  });

  // Formato real observado: a pipeline clona o repositório do sistema, pega a última tag de versão
  // (<distribuição>-<aaaammdd>.<n>) e marca a execução com "<prefixo>-<essa tag>", às vezes também
  // com um apóstrofo sobrando. A distribuição pode ser "master" ou uma release como "4.2".
  // Regra do script oficial: distribuição é o trecho antes do primeiro "-", o build é o resto.
  const FROM_TAG: SystemUnderTest = {
    name: "Sistema Exemplo",
    parts: [
      { key: "distribuicao", label: "Distribuição", source: "tag", tagPrefix: "sistema-", pattern: "^(?<value>[^-]+)-" },
      { key: "pacote", label: "Pacote", source: "tag", tagPrefix: "sistema-", pattern: "^[^-]+-(?<value>.+)$" },
    ],
  };

  it("lê distribuição e pacote da tag da execução, mesmo com a tag repetida com apóstrofo", () => {
    for (const tags of [
      ["sistema-master-20250114.18", "sistema-master-20250114.18'"],
      ["sistema-master-20250114.18'", "sistema-master-20250114.18"],
    ]) {
      expect(extractSystemVersion(FROM_TAG, { tags })?.full).toBe("master · 20250114.18");
    }
  });

  it("distribuição de release, com ponto no nome", () => {
    const v = extractSystemVersion(FROM_TAG, { tags: ["outra-tag", "sistema-4.2-20250114.3"] });
    expect(v?.parts).toEqual([
      { key: "distribuicao", label: "Distribuição", value: "4.2" },
      { key: "pacote", label: "Pacote", value: "20250114.3" },
    ]);
  });

  it("o que não foi achado fica em missing, sem inventar", () => {
    const v = extractSystemVersion(FROM_RUN_NUMBER, { runNumber: "20250116.1" });
    expect(v).toEqual({ system: "Sistema Exemplo", full: "", parts: [], missing: ["distribuicao", "pacote"] });
  });

  it("sem systemUnderTest no manifesto, não há versão", () => {
    expect(extractSystemVersion(undefined, { runNumber: "x" })).toBeUndefined();
  });
});

describe("systemUnderTest no manifesto", () => {
  const base = {
    schemaVersion: "1",
    organizationRef: "acme",
    projectRef: "p",
    provider: { kind: "azure-devops", integrationRef: "CI" },
    pipeline: { externalId: "proj/1", displayName: "testes" },
    parameters: [{ name: "branchApp", type: "string" }],
  };

  it("aceita uma configuração válida", () => {
    expect(PipelineManifestSchema.safeParse({ ...base, systemUnderTest: FROM_RUN_NUMBER }).success).toBe(true);
  });

  it("recusa regex inválida, parâmetro não declarado e parte repetida", () => {
    const r = PipelineManifestSchema.safeParse({
      ...base,
      systemUnderTest: {
        name: "X",
        parts: [
          { key: "a", label: "A", source: "runNumber", pattern: "(" },
          { key: "a", label: "A", source: "parameter", parameter: "naoExiste" },
        ],
      },
    });
    expect(r.success).toBe(false);
    const messages = r.error!.issues.map((i) => i.message);
    expect(messages).toEqual(expect.arrayContaining(["expressão regular inválida", "parte repetida: a", "parâmetro não declarado: naoExiste"]));
  });
});
