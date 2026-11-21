import { PipelineManifestSchema, type PipelineManifest } from "@painel/contracts";

// Assistência por IA é opcional (RN-038, RN-039, RF-184). A plataforma funciona inteira sem ela.
// Regras de segurança (§19.5): conteúdo vindo de MCP, repositórios e logs é dado não confiável;
// a IA só produz PROPOSTAS; a publicação passa pela mesma validação determinística do caminho manual.
// Provedores e transportes iniciais: ADR-016 (resolve P-004 e P-005).

export * from "./providers.ts";
export * from "./mcp.ts";
export * from "./agent.ts";

/** Classificação obrigatória das ferramentas MCP (§19.5): leitura ou mutação. */
export type McpToolKind = "read" | "mutate";

export interface McpToolPolicy {
  server: string;
  tool: string;
  kind: McpToolKind;
}

/**
 * Ferramentas que uma sessão assistida pode expor ao modelo (RF-176).
 * Mutações nunca são expostas diretamente: exigem confirmação separada do usuário (RF-182).
 */
export function toolsExposableToModel(policies: McpToolPolicy[], authorized: Set<string>): McpToolPolicy[] {
  return policies.filter((p) => p.kind === "read" && authorized.has(`${p.server}/${p.tool}`));
}

export type ProposalCheck =
  | { ok: true; manifest: PipelineManifest }
  | { ok: false; problems: string[] };

/**
 * Validação de uma proposta gerada pela IA (RN-041, CA-028). A proposta sempre volta como rascunho
 * que exige aprovação humana, mesmo que a IA diga o contrário.
 */
export function checkAiProposal(candidate: unknown): ProposalCheck {
  const parsed = PipelineManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`) };
  }
  return { ok: true, manifest: { ...parsed.data, review: { status: "draft", requiresHumanApproval: true } } };
}

export interface ProposalNotes {
  summary: string;
  sources: string[];
  uncertainties: string[];
}

export interface ProposalReview {
  /** Manifesto pronto para revisão (rascunho), ou null se a proposta não passou na validação. */
  manifest: PipelineManifest | null;
  /** Impede salvar: a proposta contraria o esquema ou os dados reais (CA-028). */
  problems: string[];
  /** Não impede salvar, mas a pessoa precisa olhar (ex.: recurso fora do catálogo). */
  warnings: string[];
  /** O que muda em relação ao que a descoberta automática já tinha lido. */
  changes: string[];
  notes: ProposalNotes;
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const list = (v: unknown, maxItems: number, maxLen: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, maxItems).map((x) => x.slice(0, maxLen)) : []);

/**
 * Junta a proposta da IA com o manifesto da descoberta (baseline) e confere contra os dados reais.
 * O que identifica a pipeline (organização, projeto, provedor, id externo) sempre vem do baseline:
 * a IA não muda para onde a configuração aponta. Parâmetro que o provedor não declara é recusado.
 */
export function reviewProposal(
  baseline: PipelineManifest,
  proposal: unknown,
  facts: { providerParameters: string[]; resourceRefs: string[]; reportTypes: string[] },
): ProposalReview {
  const p = (proposal && typeof proposal === "object" ? proposal : {}) as Record<string, unknown>;
  const rawNotes = (p.notes && typeof p.notes === "object" ? p.notes : {}) as Record<string, unknown>;
  const notes: ProposalNotes = { summary: text(rawNotes.summary, 2000), sources: list(rawNotes.sources, 30, 500), uncertainties: list(rawNotes.uncertainties, 30, 500) };
  const problems: string[] = [];
  const warnings: string[] = [];

  const known = new Set(facts.providerParameters);
  const parameters = Array.isArray(p.parameters) ? p.parameters : [];
  for (const raw of parameters) {
    const name = (raw as { name?: unknown })?.name;
    if (typeof name === "string" && known.size && !known.has(name)) problems.push(`parâmetro "${name.slice(0, 64)}" não existe na definição da pipeline no provedor`);
  }
  // Mantém o escopo e o "obrigatório" lidos do provedor quando a IA não diz nada.
  const byName = new Map(baseline.parameters.map((x) => [x.name, x]));
  const merged = parameters.map((raw) => {
    const r = raw as Record<string, unknown>;
    const base = typeof r.name === "string" ? byName.get(r.name) : undefined;
    return {
      ...(base ?? {}),
      ...r,
      scope: base?.scope ?? "provider",
      required: typeof r.required === "boolean" ? r.required : (base?.required ?? false),
    };
  });

  const resources = Array.isArray(p.executionResources) ? p.executionResources : baseline.executionResources;
  const catalog = new Set(facts.resourceRefs.map((r) => r.toLowerCase()));
  for (const r of resources as Array<{ ref?: unknown }>) {
    if (typeof r?.ref === "string" && !catalog.has(r.ref.toLowerCase())) warnings.push(`recurso "${r.ref.slice(0, 100)}" não está cadastrado: a execução fica bloqueada até cadastrar ou tirar`);
  }
  const reports = Array.isArray(p.reports) ? p.reports : baseline.reports;
  for (const r of reports as Array<{ type?: unknown }>) {
    if (typeof r?.type === "string" && !facts.reportTypes.includes(r.type)) warnings.push(`tipo de relatório "${r.type.slice(0, 60)}" não é lido pelo Nexo (lê: ${facts.reportTypes.join(", ")})`);
  }

  const candidate = {
    ...baseline,
    parameters: parameters.length ? merged : baseline.parameters,
    validationRules: Array.isArray(p.validationRules) ? p.validationRules : baseline.validationRules,
    executionResources: resources,
    reports,
    review: { status: "draft", requiresHumanApproval: true },
  };
  const checked = checkAiProposal(candidate);
  if (!checked.ok) problems.push(...checked.problems);
  const manifest = checked.ok && !problems.length ? checked.manifest : null;

  const changes: string[] = [];
  if (manifest) {
    for (const param of manifest.parameters) {
      const before = byName.get(param.name);
      if (!before) continue;
      const diffs: string[] = [];
      if ((param.label ?? "") !== (before.label ?? "")) diffs.push(`rótulo "${param.label ?? ""}"`);
      if (param.type !== before.type) diffs.push(`tipo ${before.type} → ${param.type}`);
      if (JSON.stringify(param.default) !== JSON.stringify(before.default)) diffs.push(`padrão ${JSON.stringify(param.default)}`);
      if (param.type === "enum" && JSON.stringify(param.options) !== JSON.stringify(before.type === "enum" ? before.options : undefined)) diffs.push(`opções ${param.options.join(", ")}`);
      if (diffs.length) changes.push(`${param.name}: ${diffs.join("; ")}`);
    }
    const dropped = baseline.parameters.filter((b) => !manifest.parameters.some((x) => x.name === b.name));
    if (dropped.length) warnings.push(`a proposta deixa de fora parâmetros do provedor: ${dropped.map((d) => d.name).join(", ")}`);
    if (manifest.validationRules.length !== baseline.validationRules.length) changes.push(`${manifest.validationRules.length} regra(s) entre parâmetros`);
    if (JSON.stringify(manifest.executionResources) !== JSON.stringify(baseline.executionResources)) {
      changes.push(`recursos: ${manifest.executionResources.map((r) => r.ref).join(", ") || "nenhum"}`);
    }
    if (JSON.stringify(manifest.reports) !== JSON.stringify(baseline.reports)) changes.push(`relatórios: ${manifest.reports.map((r) => r.type).join(", ") || "nenhum"}`);
  }
  return { manifest, problems, warnings, changes, notes };
}
