import { z } from "zod";

// Manifesto de configuração de pipeline (ADR-008; §19.1 e §19.4 da especificação).
// É a representação única produzida pelo onboarding manual, pelo assistido por IA e pela importação.
// Nunca contém segredos, só referências (integrationRef): RNF-033, CA-040.

const ref = z.string().min(1).max(200);
const paramName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, "nome de parâmetro inválido");
const scalar = z.union([z.string(), z.number(), z.boolean()]);

const ParameterBase = z.object({
  name: paramName,
  label: z.string().max(200).optional(),
  required: z.boolean().default(false),
  /** Parâmetro comum à plataforma ou específico do provedor (RF-035). */
  scope: z.enum(["common", "provider"]).default("provider"),
});

export const ParameterSpecSchema = z.discriminatedUnion("type", [
  ParameterBase.extend({ type: z.literal("string"), default: z.string().optional() }),
  ParameterBase.extend({ type: z.literal("number"), default: z.number().optional() }),
  ParameterBase.extend({ type: z.literal("boolean"), default: z.boolean().optional() }),
  ParameterBase.extend({
    type: z.literal("enum"),
    options: z.array(z.string().min(1)).min(1),
    default: z.string().optional(),
  }),
]);
export type ParameterSpec = z.infer<typeof ParameterSpecSchema>;

/**
 * Regra declarativa entre parâmetros (RF-034). Exemplo, como dado de projeto e não do núcleo:
 * when runSmoke = true then database in [chromium].
 */
export const ValidationRuleSchema = z.object({
  id: z.string().min(1).max(100),
  message: z.string().min(1).max(500),
  when: z.object({ parameter: paramName, equals: scalar }),
  then: z.object({ parameter: paramName, in: z.array(scalar).min(1) }),
});
export type ValidationRule = z.infer<typeof ValidationRuleSchema>;

/**
 * Uma parte da versão do sistema em teste (ex.: distribuição, pacote) e de onde lê-la na execução:
 * o número da execução no provedor, uma tag que a pipeline pôs, ou um parâmetro. `pattern` recorta o
 * valor: o grupo nomeado "value", se houver, senão o trecho que casou.
 */
const PATTERN_MAX = 300;
export const VersionPartSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, "chave inválida"),
    label: z.string().min(1).max(60),
    source: z.enum(["runNumber", "tag", "parameter"]),
    /** source = "parameter": o parâmetro do manifesto. */
    parameter: paramName.optional(),
    /** source = "tag": a primeira tag que começa com este prefixo (o prefixo sai do valor). */
    tagPrefix: z.string().min(1).max(100).optional(),
    pattern: z.string().min(1).max(PATTERN_MAX).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.source === "parameter" && !p.parameter) ctx.addIssue({ code: "custom", path: ["parameter"], message: "informe o parâmetro" });
    if (p.source !== "parameter" && p.parameter) ctx.addIssue({ code: "custom", path: ["parameter"], message: "só vale com source = parameter" });
    if (p.source !== "tag" && p.tagPrefix) ctx.addIssue({ code: "custom", path: ["tagPrefix"], message: "só vale com source = tag" });
    if (p.pattern) {
      try {
        new RegExp(p.pattern);
      } catch {
        ctx.addIssue({ code: "custom", path: ["pattern"], message: "expressão regular inválida" });
      }
    }
  });
export type VersionPart = z.infer<typeof VersionPartSchema>;

/** Qual sistema a pipeline testa e como achar a versão dele em cada execução. */
export const SystemUnderTestSchema = z
  .object({
    name: z.string().min(1).max(120),
    parts: z.array(VersionPartSchema).min(1).max(8),
  })
  .strict();
export type SystemUnderTest = z.infer<typeof SystemUnderTestSchema>;

export const PipelineManifestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    organizationRef: ref,
    projectRef: ref,
    provider: z.object({ kind: ref, integrationRef: ref }).strict(),
    pipeline: z.object({ externalId: ref, displayName: z.string().min(1).max(200) }).strict(),
    parameters: z.array(ParameterSpecSchema).default([]),
    validationRules: z.array(ValidationRuleSchema).default([]),
    executionResources: z.array(z.object({ ref, exclusive: z.boolean() }).strict()).default([]),
    reports: z.array(z.object({ type: ref }).strict()).default([]),
    systemUnderTest: SystemUnderTestSchema.optional(),
    review: z
      .object({
        status: z.enum(["draft", "approved"]),
        requiresHumanApproval: z.boolean(),
      })
      .strict()
      .default({ status: "draft", requiresHumanApproval: true }),
  })
  .strict()
  .superRefine((m, ctx) => {
    const names = new Set<string>();
    m.parameters.forEach((p, i) => {
      if (names.has(p.name)) {
        ctx.addIssue({ code: "custom", path: ["parameters", i, "name"], message: `parâmetro duplicado: ${p.name}` });
      }
      names.add(p.name);
      if (p.type === "enum" && p.default !== undefined && !p.options.includes(p.default)) {
        ctx.addIssue({ code: "custom", path: ["parameters", i, "default"], message: "valor padrão fora das opções" });
      }
    });
    const keys = new Set<string>();
    m.systemUnderTest?.parts.forEach((p, i) => {
      if (keys.has(p.key)) ctx.addIssue({ code: "custom", path: ["systemUnderTest", "parts", i, "key"], message: `parte repetida: ${p.key}` });
      keys.add(p.key);
      if (p.parameter && !names.has(p.parameter)) {
        ctx.addIssue({ code: "custom", path: ["systemUnderTest", "parts", i, "parameter"], message: `parâmetro não declarado: ${p.parameter}` });
      }
    });
    m.validationRules.forEach((r, i) => {
      for (const side of ["when", "then"] as const) {
        if (!names.has(r[side].parameter)) {
          ctx.addIssue({
            code: "custom",
            path: ["validationRules", i, side, "parameter"],
            message: `regra referencia parâmetro não declarado: ${r[side].parameter}`,
          });
        }
      }
    });
  });

export type PipelineManifest = z.infer<typeof PipelineManifestSchema>;

export type ParameterValue = string | number | boolean;

/**
 * Converte valores sem tipo vindos do provedor (ex.: "True", "false", "42") usando os tipos declarados.
 * Valores que não convertem ficam como texto, para a validação acusar em vez de esconder (RN-044).
 * Parâmetros sem especificação também ficam como texto.
 */
export function coerceParameterValues(
  specs: readonly ParameterSpec[],
  raw: Record<string, string>,
): Record<string, ParameterValue> {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const out: Record<string, ParameterValue> = {};
  for (const [name, value] of Object.entries(raw)) {
    const spec = byName.get(name);
    if (spec?.type === "boolean") {
      const v = value.trim().toLowerCase();
      out[name] = v === "true" ? true : v === "false" ? false : value;
    } else if (spec?.type === "number") {
      const n = Number(value);
      out[name] = value.trim() !== "" && Number.isFinite(n) ? n : value;
    } else {
      out[name] = value;
    }
  }
  return out;
}

export interface ParameterViolation {
  parameter: string;
  message: string;
  ruleId?: string;
}

/**
 * Validação determinística dos valores de uma execução contra o manifesto (RF-034, RN-041, CA-006).
 * É a mesma para o caminho manual e para as propostas da IA.
 */
export function validateParameterValues(
  manifest: PipelineManifest,
  values: Record<string, ParameterValue>,
): { effective: Record<string, ParameterValue>; violations: ParameterViolation[] } {
  const violations: ParameterViolation[] = [];
  const effective: Record<string, ParameterValue> = {};
  const specs = new Map(manifest.parameters.map((p) => [p.name, p]));

  for (const name of Object.keys(values)) {
    if (!specs.has(name)) violations.push({ parameter: name, message: "parâmetro não declarado no manifesto" });
  }

  for (const spec of manifest.parameters) {
    const value = values[spec.name] ?? spec.default;
    if (value === undefined) {
      if (spec.required) violations.push({ parameter: spec.name, message: "parâmetro obrigatório sem valor" });
      continue;
    }
    const expected = spec.type === "enum" ? "string" : spec.type;
    if (typeof value !== expected) {
      violations.push({ parameter: spec.name, message: `tipo esperado: ${spec.type}` });
      continue;
    }
    if (spec.type === "enum" && !spec.options.includes(value as string)) {
      violations.push({ parameter: spec.name, message: `valor fora das opções: ${spec.options.join(", ")}` });
      continue;
    }
    effective[spec.name] = value;
  }

  for (const rule of manifest.validationRules) {
    if (effective[rule.when.parameter] !== rule.when.equals) continue;
    const actual = effective[rule.then.parameter];
    if (actual === undefined || !rule.then.in.includes(actual)) {
      violations.push({ parameter: rule.then.parameter, message: rule.message, ruleId: rule.id });
    }
  }

  return { effective, violations };
}

/** Versão do sistema em teste capturada numa execução. `missing` = partes que não foram achadas. */
export interface SystemVersion {
  system: string;
  /** Texto completo para exibir, com as partes achadas na ordem do manifesto. */
  full: string;
  parts: Array<{ key: string; label: string; value: string }>;
  missing: string[];
}

const MAX_VERSION_INPUT = 200;

/** Tira espaços e aspas soltas nas pontas (ex.: o apóstrofo que sobra no número da execução, S1 achado 7). */
function cleanVersionText(value: string): string {
  return value.trim().replace(/^['"`]+|['"`]+$/g, "").trim().slice(0, MAX_VERSION_INPUT);
}

/**
 * Lê a versão do sistema em teste de uma execução, conforme o manifesto. Determinística e sem
 * inventar: parte não achada fica em `missing`. Devolve undefined se o manifesto não declara nada.
 */
export function extractSystemVersion(
  sut: SystemUnderTest | undefined,
  run: { runNumber?: string | null; tags?: readonly string[] | null; parameters?: Record<string, ParameterValue> | null },
): SystemVersion | undefined {
  if (!sut) return undefined;
  const parts: SystemVersion["parts"] = [];
  const missing: string[] = [];
  for (const part of sut.parts) {
    let raw: string | undefined;
    if (part.source === "runNumber") raw = run.runNumber ?? undefined;
    else if (part.source === "parameter") {
      const v = run.parameters?.[part.parameter!];
      raw = v === undefined ? undefined : String(v);
    } else {
      const prefix = part.tagPrefix ?? "";
      const tag = (run.tags ?? []).find((t) => t.startsWith(prefix));
      raw = tag === undefined ? undefined : tag.slice(prefix.length);
    }
    let value = raw === undefined ? undefined : cleanVersionText(raw);
    if (value && part.pattern) {
      const m = new RegExp(part.pattern).exec(value);
      value = m ? cleanVersionText(m.groups?.value ?? m[0]) : undefined;
    }
    if (value) parts.push({ key: part.key, label: part.label, value });
    else missing.push(part.key);
  }
  return { system: sut.name, full: parts.map((p) => p.value).join(" · "), parts, missing };
}
