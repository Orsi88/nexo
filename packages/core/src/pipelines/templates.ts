import { DomainError } from "../shared/errors.ts";

// Modelos de pipeline (incremento 4): o assistente pergunta só o necessário e monta o YAML do
// provedor, já publicando o relatório num artefato que o Nexo lê (incremento 5). O YAML gerado
// aparece para revisão e pode ser editado antes de gravar; nada é escondido.
// Valores entram sempre entre aspas JSON (YAML válido), então nenhum campo injeta estrutura.

export type TemplateProvider = "azure-devops" | "github";

export interface TemplateField {
  key: string;
  label: string;
  help?: string;
  kind: "text" | "boolean" | "select";
  default: string | boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  required?: boolean;
}

export interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  /** O que o Nexo vai ler depois da execução. */
  report: string;
  fields: TemplateField[];
}

type Values = Record<string, string | boolean>;

const q = (v: string) => JSON.stringify(v);
const CRON = /^(\S+\s+){4}\S+$/;

const AGENT: TemplateField = {
  key: "agent",
  label: "Onde roda",
  help: "ubuntu-latest usa uma máquina do provedor. Para a máquina de vocês, informe o nome do pool (Azure) ou o rótulo do runner (GitHub).",
  kind: "text",
  default: "ubuntu-latest",
  required: true,
};
const WORKDIR: TemplateField = { key: "workingDirectory", label: "Pasta do projeto de testes", help: "Relativa à raiz do repositório.", kind: "text", default: "." };
const SCHEDULE: TemplateField = {
  key: "schedule",
  label: "Agenda (opcional)",
  help: "Formato cron, em UTC. Ex.: 0 6 * * 1-5 = dias úteis às 6h UTC. Vazio = só quando alguém executar.",
  kind: "text",
  default: "",
  placeholder: "0 6 * * 1-5",
};
const SUITE_CHOICE: TemplateField = {
  key: "withMode",
  label: "Ter a escolha de suíte",
  help: "Cria o parâmetro suite (regressao ou smoke), escolhido na hora de executar, sem mexer no arquivo.",
  kind: "boolean",
  default: false,
};
const NODE: TemplateField = {
  key: "nodeVersion",
  label: "Versão do Node",
  kind: "select",
  default: "22",
  options: ["18", "20", "22", "24"].map((v) => ({ value: v, label: `Node ${v}` })),
};

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    id: "playwright",
    name: "Playwright",
    description: "Testes de interface com Playwright em Node. Instala os navegadores, roda e publica o relatório.",
    report: "JSON e JUnit do Playwright (pasta test-results)",
    fields: [
      AGENT,
      WORKDIR,
      NODE,
      { key: "testCommand", label: "Comando dos testes", kind: "text", default: "npx playwright test", required: true },
      SUITE_CHOICE,
      SCHEDULE,
    ],
  },
  {
    id: "node-junit",
    name: "Testes em Node (JUnit)",
    description: "Qualquer runner Node que gere JUnit XML: node --test, Vitest, Jest, Mocha.",
    report: "JUnit XML",
    fields: [
      AGENT,
      WORKDIR,
      NODE,
      {
        key: "testCommand",
        label: "Comando dos testes",
        help: "Precisa gravar o JUnit no arquivo abaixo.",
        kind: "text",
        default: "node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=test-results/junit.xml",
        required: true,
      },
      { key: "reportFile", label: "Arquivo do JUnit", kind: "text", default: "test-results/junit.xml", required: true },
      SUITE_CHOICE,
      SCHEDULE,
    ],
  },
  {
    id: "k6",
    name: "Desempenho com k6",
    description: "Teste de carga com k6. O resumo vira métrica de desempenho, separada da taxa de aprovação.",
    report: "Resumo do k6 (summary.json)",
    fields: [AGENT, WORKDIR, { key: "script", label: "Script do k6", kind: "text", default: "tests/carga.js", required: true }, SCHEDULE],
  },
  {
    id: "command",
    name: "Comando livre",
    description: "Você diz o comando e onde fica o relatório. Serve para qualquer linguagem.",
    report: "O arquivo informado (JUnit XML ou JSON do Playwright)",
    fields: [
      AGENT,
      WORKDIR,
      { key: "setupCommand", label: "Preparação (opcional)", help: "Ex.: instalar dependências.", kind: "text", default: "" },
      { key: "testCommand", label: "Comando dos testes", kind: "text", default: "", required: true, placeholder: "./gradlew test" },
      { key: "reportPath", label: "Pasta ou arquivo do relatório", kind: "text", default: "test-results", required: true },
      SUITE_CHOICE,
      SCHEDULE,
    ],
  },
];

export function slugify(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "testes"
  );
}

export function defaultPipelinePath(provider: TemplateProvider, name: string): string {
  return provider === "github" ? `.github/workflows/${slugify(name)}.yml` : `pipelines/${slugify(name)}.yml`;
}

/** Valida e completa os valores com os padrões do modelo. */
function readValues(t: PipelineTemplate, input: Record<string, unknown>): Values {
  const out: Values = {};
  for (const f of t.fields) {
    const raw = input[f.key];
    if (f.kind === "boolean") {
      out[f.key] = raw === undefined ? f.default : raw === true;
      continue;
    }
    const v = raw === undefined || raw === null ? String(f.default) : typeof raw === "string" ? raw.trim() : "";
    if (/[\r\n]/.test(v)) throw new DomainError("invalid", `${f.label}: use uma linha só.`);
    if (v.length > 400) throw new DomainError("invalid", `${f.label}: no máximo 400 caracteres.`);
    if (f.required && !v) throw new DomainError("invalid", `Informe: ${f.label}.`);
    if (f.options && !f.options.some((o) => o.value === v)) throw new DomainError("invalid", `${f.label}: opção inválida.`);
    out[f.key] = v;
  }
  if (out.schedule && !CRON.test(String(out.schedule))) throw new DomainError("invalid", "Agenda: use o formato cron com 5 campos (ex.: 0 6 * * 1-5).");
  return out;
}

interface Step {
  name: string;
  run: string;
  env?: Record<string, string>;
}

/** Passos do modelo, iguais para os dois provedores; cada um traduz para o seu YAML. */
function stepsFor(t: PipelineTemplate, v: Values): { node?: string; steps: Step[]; artifact: string } {
  const dir = String(v.workingDirectory || ".");
  const inDir = (p: string) => (dir === "." ? p : `${dir.replace(/\/+$/, "")}/${p}`);
  switch (t.id) {
    case "playwright":
      return {
        node: String(v.nodeVersion),
        steps: [
          { name: "Instalar dependências", run: "npm ci" },
          { name: "Instalar navegadores", run: "npx playwright install --with-deps" },
          {
            name: "Rodar testes",
            run: `${v.testCommand} --reporter=list,json,junit`,
            env: { PLAYWRIGHT_JSON_OUTPUT_NAME: "test-results/results.json", PLAYWRIGHT_JUNIT_OUTPUT_NAME: "test-results/junit.xml" },
          },
        ],
        artifact: inDir("test-results"),
      };
    case "node-junit":
      return {
        node: String(v.nodeVersion),
        steps: [
          { name: "Instalar dependências", run: "npm ci" },
          { name: "Rodar testes", run: String(v.testCommand) },
        ],
        artifact: inDir(String(v.reportFile)),
      };
    case "k6":
      return {
        steps: [{ name: "Rodar k6", run: `mkdir -p test-results && k6 run --summary-export=test-results/summary.json ${v.script}` }],
        artifact: inDir("test-results"),
      };
    default:
      return {
        steps: [...(v.setupCommand ? [{ name: "Preparar", run: String(v.setupCommand) }] : []), { name: "Rodar testes", run: String(v.testCommand) }],
        artifact: inDir(String(v.reportPath)),
      };
  }
}

const isHosted = (agent: string) => /-latest$|^(ubuntu|windows|macos)-/.test(agent);

function azureYaml(t: PipelineTemplate, name: string, v: Values): string {
  const { node, steps, artifact } = stepsFor(t, v);
  const dir = String(v.workingDirectory || ".");
  const agent = String(v.agent);
  const out: string[] = [`# ${name}: criada pelo Nexo a partir do modelo "${t.name}".`, "trigger: none", ""];
  if (v.schedule) {
    out.push("schedules:", `  - cron: ${q(String(v.schedule))}`, `    displayName: ${q("Agenda do Nexo")}`, "    branches:", "      include: [main]", "    always: true", "");
  }
  if (v.withMode) {
    out.push(
      "parameters:",
      "  - name: suite",
      `    displayName: ${q("Modo dos testes")}`,
      "    type: string",
      "    default: regressao",
      "    values: [regressao, smoke]",
      "",
    );
  }
  out.push("pool:", isHosted(agent) ? `  vmImage: ${q(agent)}` : `  name: ${q(agent)}`, "", "steps:", "  - checkout: self");
  if (node) out.push("  - task: NodeTool@0", `    displayName: ${q(`Node ${node}`)}`, "    inputs:", `      versionSpec: ${q(`${node}.x`)}`);
  for (const s of steps) {
    out.push(`  - script: ${q(s.run)}`, `    displayName: ${q(s.name)}`, `    workingDirectory: ${q(dir)}`);
    const env = { ...(s.env ?? {}), ...(v.withMode && s.name === "Rodar testes" ? { SUITE_TESTES: "${{ parameters.suite }}" } : {}) };
    if (Object.keys(env).length) {
      out.push("    env:");
      for (const [k, val] of Object.entries(env)) out.push(`      ${k}: ${q(val)}`);
    }
  }
  out.push(
    "  - task: PublishPipelineArtifact@1",
    `    displayName: ${q("Publicar relatório para o Nexo")}`,
    "    condition: always()",
    "    inputs:",
    `      targetPath: ${q(artifact)}`,
    "      artifact: test-results",
  );
  return out.join("\n") + "\n";
}

function githubYaml(t: PipelineTemplate, name: string, v: Values): string {
  const { node, steps, artifact } = stepsFor(t, v);
  const dir = String(v.workingDirectory || ".");
  const out: string[] = [`# Criado pelo Nexo a partir do modelo "${t.name}".`, `name: ${q(name)}`, "", "on:", "  workflow_dispatch:"];
  if (v.withMode) {
    out.push(
      "    inputs:",
      "      suite:",
      `        description: ${q("Modo dos testes")}`,
      "        type: choice",
      "        options: [regressao, smoke]",
      "        default: regressao",
    );
  }
  if (v.schedule) out.push("  schedule:", `    - cron: ${q(String(v.schedule))}`);
  out.push("", "jobs:", "  testes:", `    runs-on: ${q(String(v.agent))}`, "    defaults:", "      run:", `        working-directory: ${q(dir)}`, "    steps:", "      - uses: actions/checkout@v4");
  if (node) out.push("      - uses: actions/setup-node@v4", "        with:", `          node-version: ${q(node)}`);
  for (const s of steps) {
    out.push(`      - name: ${q(s.name)}`, `        run: ${q(s.run)}`);
    const env = { ...(s.env ?? {}), ...(v.withMode && s.name === "Rodar testes" ? { SUITE_TESTES: "${{ inputs.suite || 'regressao' }}" } : {}) };
    if (Object.keys(env).length) {
      out.push("        env:");
      for (const [k, val] of Object.entries(env)) out.push(`          ${k}: ${q(val)}`);
    }
  }
  out.push(
    `      - name: ${q("Publicar relatório para o Nexo")}`,
    "        if: always()",
    "        uses: actions/upload-artifact@v4",
    "        with:",
    "          name: test-results",
    `          path: ${q(artifact)}`,
  );
  return out.join("\n") + "\n";
}

export function renderTemplate(provider: TemplateProvider, templateId: string, name: string, input: Record<string, unknown>): { content: string; path: string } {
  const t = PIPELINE_TEMPLATES.find((x) => x.id === templateId);
  if (!t) throw new DomainError("invalid", "Modelo de pipeline desconhecido.");
  const clean = name.trim();
  if (!clean || clean.length > 120 || /[\r\n]/.test(clean)) throw new DomainError("invalid", "Informe um nome de até 120 caracteres.");
  const values = readValues(t, input);
  const content = provider === "github" ? githubYaml(t, clean, values) : azureYaml(t, clean, values);
  return { content, path: defaultPipelinePath(provider, clean) };
}
