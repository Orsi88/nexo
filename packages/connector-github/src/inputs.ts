import { parseDocument } from "yaml";
import { ParameterSpecSchema, type ParameterSpec } from "@painel/contracts";

// Lê as entradas de `on.workflow_dispatch.inputs` de um workflow do GitHub Actions e traduz para
// ParameterSpec. São elas que a API de disparo aceita em `inputs`.
// Tipos do GitHub: string, boolean, number, choice (lista) e environment (nome de ambiente, texto).

export class WorkflowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowParseError";
  }
}

export interface ParsedWorkflow {
  /** O workflow aceita disparo externo (tem `workflow_dispatch`). Sem isso, só dá para ler as execuções. */
  dispatchable: boolean;
  inputs: ParameterSpec[];
}

const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function parseWorkflowInputs(content: string): ParsedWorkflow {
  // YAML 1.2 (padrão da biblioteca): a chave "on" continua sendo o texto "on", não o booleano true.
  const doc = parseDocument(content, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) throw new WorkflowParseError(`YAML inválido: ${doc.errors[0]?.message ?? "erro de sintaxe"}`);
  const root: unknown = doc.toJS({ maxAliasCount: 50 });
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new WorkflowParseError("o workflow precisa ser um mapa na raiz");
  const on = (root as Record<string, unknown>).on ?? (root as Record<string, unknown>).true;

  // "on" pode ser texto ("on: push"), lista ("on: [push, workflow_dispatch]") ou mapa.
  if (typeof on === "string") return { dispatchable: on === "workflow_dispatch", inputs: [] };
  if (Array.isArray(on)) return { dispatchable: on.includes("workflow_dispatch"), inputs: [] };
  if (!on || typeof on !== "object" || !("workflow_dispatch" in on)) return { dispatchable: false, inputs: [] };

  const dispatch = (on as Record<string, unknown>).workflow_dispatch;
  const declared = dispatch && typeof dispatch === "object" ? (dispatch as Record<string, unknown>).inputs : undefined;
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) return { dispatchable: true, inputs: [] };

  const inputs: ParameterSpec[] = [];
  for (const [name, raw] of Object.entries(declared as Record<string, unknown>)) {
    if (!NAME.test(name)) throw new WorkflowParseError(`entrada com nome que a plataforma não aceita: ${name.slice(0, 64)}`);
    const def = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const type = typeof def.type === "string" ? def.type : "string";
    const base = {
      name,
      required: def.required === true,
      scope: "provider" as const,
      ...(typeof def.description === "string" && def.description.trim() ? { label: def.description.trim().slice(0, 200) } : {}),
    };
    let spec: unknown;
    if (type === "boolean") {
      const d = asBoolean(def.default);
      spec = { ...base, type: "boolean", ...(d !== undefined ? { default: d } : {}) };
    } else if (type === "number") {
      const d = asNumber(def.default);
      spec = { ...base, type: "number", ...(d !== undefined ? { default: d } : {}) };
    } else if (type === "choice") {
      const options = Array.isArray(def.options) ? def.options.map((o) => String(o)) : [];
      if (!options.length) throw new WorkflowParseError(`a entrada ${name} é do tipo choice mas não tem options`);
      const d = def.default === undefined ? undefined : String(def.default);
      spec = { ...base, type: "enum", options, ...(d !== undefined && options.includes(d) ? { default: d } : {}) };
    } else {
      // string e environment (nome de ambiente) viram texto.
      spec = { ...base, type: "string", ...(def.default !== undefined && def.default !== null ? { default: String(def.default) } : {}) };
    }
    const parsed = ParameterSpecSchema.safeParse(spec);
    if (!parsed.success) throw new WorkflowParseError(`entrada ${name}: ${parsed.error.issues[0]?.message ?? "inválida"}`);
    inputs.push(parsed.data);
  }
  return { dispatchable: true, inputs };
}
