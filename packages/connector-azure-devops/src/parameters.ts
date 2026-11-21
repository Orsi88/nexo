import { parseDocument } from "yaml";
import { ParameterSpecSchema, type ParameterSpec } from "@painel/contracts";

// Lê os "parameters:" de runtime de um YAML do Azure Pipelines e traduz para ParameterSpec.
// Só o bloco de parâmetros da raiz: é o que a API de disparo aceita em templateParameters.

/** Tipos de parâmetro do Azure que a plataforma consegue representar num formulário. */
const SCALAR_TYPES = new Set(["string", "number", "boolean"]);

export class ParameterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParameterParseError";
  }
}

export interface ParsedParameters {
  parameters: ParameterSpec[];
  /**
   * Parâmetros que existem no YAML mas não viram campo (tipos object, step, job...).
   * Só aparecem aqui quando têm valor padrão: o Azure usa o padrão e o disparo continua possível.
   */
  skipped: Array<{ name: string; type: string }>;
}

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

export function parseYamlParameters(content: string): ParsedParameters {
  const doc = parseDocument(content, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new ParameterParseError(`YAML inválido: ${doc.errors[0]?.message ?? "erro de sintaxe"}`);
  }
  const root: unknown = doc.toJS({ maxAliasCount: 50 });
  if (root === null || root === undefined) return { parameters: [], skipped: [] };
  if (typeof root !== "object" || Array.isArray(root)) {
    throw new ParameterParseError("YAML da pipeline precisa ser um mapa na raiz");
  }
  const declared = (root as Record<string, unknown>).parameters;
  if (declared === undefined || declared === null) return { parameters: [], skipped: [] };
  if (!Array.isArray(declared)) {
    // Forma antiga ("parameters: { nome: valor }"), sem tipos: não dá para montar o formulário com segurança.
    throw new ParameterParseError("parameters precisa ser uma lista com name e type (forma tipada do Azure Pipelines)");
  }

  const parameters: ParameterSpec[] = [];
  const skipped: ParsedParameters["skipped"] = [];

  declared.forEach((item: unknown, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ParameterParseError(`parâmetro ${index + 1}: esperado um mapa com name e type`);
    }
    const p = item as Record<string, unknown>;
    const name = p.name;
    if (typeof name !== "string" || name === "") {
      throw new ParameterParseError(`parâmetro ${index + 1}: name ausente`);
    }
    const type = p.type === undefined ? "string" : p.type; // o Azure assume string quando type é omitido
    if (typeof type !== "string") throw new ParameterParseError(`parâmetro ${name}: type inválido`);
    const hasDefault = Object.hasOwn(p, "default");
    const label = typeof p.displayName === "string" ? p.displayName.slice(0, 200) : undefined;

    if (!SCALAR_TYPES.has(type)) {
      if (!hasDefault) {
        throw new ParameterParseError(
          `parâmetro ${name}: tipo ${type} sem valor padrão não pode ser preenchido pela plataforma`,
        );
      }
      skipped.push({ name, type });
      return;
    }

    const values = p.values;
    if (values !== undefined && !Array.isArray(values)) {
      throw new ParameterParseError(`parâmetro ${name}: values precisa ser uma lista`);
    }

    let spec: unknown;
    if (Array.isArray(values) && type !== "boolean") {
      const options = values.map((v) => String(v));
      spec = {
        name,
        label,
        type: "enum",
        options,
        default: hasDefault ? String(p.default) : undefined,
        required: !hasDefault,
      };
    } else if (type === "boolean") {
      const def = hasDefault ? asBoolean(p.default) : undefined;
      if (hasDefault && def === undefined) throw new ParameterParseError(`parâmetro ${name}: padrão não é booleano`);
      spec = { name, label, type: "boolean", default: def, required: !hasDefault };
    } else if (type === "number") {
      const def = hasDefault ? asNumber(p.default) : undefined;
      if (hasDefault && def === undefined) throw new ParameterParseError(`parâmetro ${name}: padrão não é número`);
      spec = { name, label, type: "number", default: def, required: !hasDefault };
    } else {
      spec = {
        name,
        label,
        type: "string",
        default: hasDefault && p.default !== null ? String(p.default) : undefined,
        required: !hasDefault,
      };
    }

    const parsed = ParameterSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ParameterParseError(`parâmetro ${name}: ${parsed.error.issues[0]?.message ?? "inválido"}`);
    }
    parameters.push(parsed.data);
  });

  return { parameters, skipped };
}
