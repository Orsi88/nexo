// Ferramentas do servidor MCP do Nexo (ADR-017). Cada ferramenta vira uma chamada à rota REST que já
// existe, com o mesmo token: validação, permissão por papel e auditoria são as do painel, sem regra
// duplicada aqui. Ficam de fora, de propósito: credenciais de integração (segredo não passa pelo
// modelo), membros e papéis, política de acesso, arquivamento de organização e tokens.

export interface ToolRequest {
  method: "GET" | "POST" | "PUT" | "PATCH";
  url: string;
  payload?: Record<string, unknown>;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
  /** Só lê: o cliente pode chamar sem pedir confirmação. */
  readOnly: boolean;
  /** Mexe fora do Nexo ou não tem volta (commit no repositório, execução no provedor). */
  destructive?: boolean;
  request(args: Record<string, unknown>): ToolRequest;
}

interface JsonSchemaObject {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Erro de argumento: volta para o modelo como resultado com isError, para ele corrigir e tentar de novo. */
export class ToolArgumentError extends Error {}

function id(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !UUID.test(value)) throw new ToolArgumentError(`"${key}" precisa ser um id (uuid).`);
  return value;
}

function text(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ToolArgumentError(`"${key}" precisa ser texto.`);
  return value;
}

function required(args: Record<string, unknown>, key: string): string {
  const value = text(args, key);
  if (value === undefined) throw new ToolArgumentError(`Informe "${key}".`);
  return value;
}

function query(path: string, params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** Copia só as chaves presentes (o REST recusa campos desconhecidos com tipo errado, não ausentes). */
function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
}

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const uuid = (description: string) => str(description, { format: "uuid" });
const obj = (properties: JsonSchemaObject["properties"], requiredKeys: string[] = []): JsonSchemaObject => ({
  type: "object",
  properties,
  ...(requiredKeys.length ? { required: requiredKeys } : {}),
  additionalProperties: false,
});
const SCALARS = { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } };
const enc = encodeURIComponent;

export const MCP_TOOLS: McpTool[] = [
  // ----- Contexto -----
  {
    name: "get_context",
    title: "Contexto do token",
    description:
      "Quem é o usuário do token, a organização a que o token pertence, o papel e o que esse papel permite. Chame primeiro para saber o que dá para fazer.",
    inputSchema: obj({}),
    readOnly: true,
    request: () => ({ method: "GET", url: "/api/session" }),
  },

  // ----- Estrutura -----
  {
    name: "list_workspaces",
    title: "Listar workspaces",
    description: "Workspaces da organização. Um workspace agrupa projetos (por exemplo, uma empresa ou equipe).",
    inputSchema: obj({ q: str("Filtra pelo nome."), includeArchived: { type: "boolean" } }),
    readOnly: true,
    request: (a) => ({ method: "GET", url: query("/api/workspaces", { q: text(a, "q"), includeArchived: a.includeArchived === true || undefined }) }),
  },
  {
    name: "create_workspace",
    title: "Criar workspace",
    description: "Cria um workspace na organização.",
    inputSchema: obj({ name: str("Nome do workspace.") }, ["name"]),
    readOnly: false,
    request: (a) => ({ method: "POST", url: "/api/workspaces", payload: { name: required(a, "name") } }),
  },
  {
    name: "list_projects",
    title: "Listar projetos",
    description: "Projetos da organização, opcionalmente de um workspace. Pipelines são vinculadas a projetos.",
    inputSchema: obj({ workspaceId: uuid("Só os projetos deste workspace."), q: str("Filtra pelo nome."), includeArchived: { type: "boolean" } }),
    readOnly: true,
    request: (a) => ({
      method: "GET",
      url: query("/api/projects", {
        workspaceId: a.workspaceId === undefined ? undefined : id(a, "workspaceId"),
        q: text(a, "q"),
        includeArchived: a.includeArchived === true || undefined,
      }),
    }),
  },
  {
    name: "create_project",
    title: "Criar projeto",
    description: "Cria um projeto dentro de um workspace.",
    inputSchema: obj({ workspaceId: uuid("Workspace do projeto."), name: str("Nome do projeto.") }, ["workspaceId", "name"]),
    readOnly: false,
    request: (a) => ({ method: "POST", url: "/api/projects", payload: { workspaceId: id(a, "workspaceId"), name: required(a, "name") } }),
  },
  {
    name: "update_project",
    title: "Renomear ou mover projeto",
    description: "Muda o nome de um projeto ou o move para outro workspace.",
    inputSchema: obj({ projectId: uuid("Projeto."), name: str("Novo nome."), workspaceId: uuid("Novo workspace.") }, ["projectId"]),
    readOnly: false,
    request: (a) => ({
      method: "PATCH",
      url: `/api/projects/${enc(id(a, "projectId"))}`,
      payload: { ...pick(a, ["name"]), ...(a.workspaceId === undefined ? {} : { workspaceId: id(a, "workspaceId") }) },
    }),
  },

  // ----- Integrações e descoberta -----
  {
    name: "list_integrations",
    title: "Listar integrações",
    description:
      "Integrações com provedores de CI (Azure DevOps, GitHub) da organização. Credenciais nunca aparecem. Criar ou trocar credencial é só pelo painel.",
    inputSchema: obj({}),
    readOnly: true,
    request: () => ({ method: "GET", url: "/api/integrations" }),
  },
  {
    name: "discover_pipelines",
    title: "Descobrir pipelines no provedor",
    description:
      "Pipelines que existem no provedor da integração, marcando as já vinculadas. Use o externalId do resultado em link_pipeline. Paginado: repita com o cursor devolvido.",
    inputSchema: obj({ integrationId: uuid("Integração."), q: str("Filtra pelo nome."), cursor: str("Cursor da página anterior.") }, ["integrationId"]),
    readOnly: true,
    request: (a) => ({ method: "GET", url: query(`/api/integrations/${enc(id(a, "integrationId"))}/discover`, { q: text(a, "q"), cursor: text(a, "cursor") }) }),
  },

  // ----- Pipelines vinculadas -----
  {
    name: "list_pipelines",
    title: "Listar pipelines vinculadas",
    description: "Pipelines já vinculadas a projetos no Nexo.",
    inputSchema: obj({ projectId: uuid("Só as deste projeto."), q: str("Filtra pelo nome."), includeArchived: { type: "boolean" } }),
    readOnly: true,
    request: (a) => ({
      method: "GET",
      url: query("/api/pipelines", {
        projectId: a.projectId === undefined ? undefined : id(a, "projectId"),
        q: text(a, "q"),
        includeArchived: a.includeArchived === true || undefined,
      }),
    }),
  },
  {
    name: "link_pipeline",
    title: "Vincular pipeline existente",
    description:
      "Traz uma pipeline que já existe no provedor para um projeto do Nexo. Não cria nada no provedor. O externalId vem de discover_pipelines.",
    inputSchema: obj(
      {
        projectId: uuid("Projeto de destino."),
        integrationId: uuid("Integração onde a pipeline está."),
        externalId: str("Id da pipeline no provedor (de discover_pipelines)."),
        ref: str("Branch de onde ler os parâmetros (opcional)."),
      },
      ["projectId", "integrationId", "externalId"],
    ),
    readOnly: false,
    request: (a) => ({
      method: "POST",
      url: "/api/pipelines",
      payload: { projectId: id(a, "projectId"), integrationId: id(a, "integrationId"), externalId: required(a, "externalId"), ...pick(a, ["ref"]) },
    }),
  },
  {
    name: "get_pipeline",
    title: "Detalhar pipeline",
    description: "Dados sincronizados da pipeline: revisão, parâmetros, capacidades do provedor e diferenças em relação ao manifesto.",
    inputSchema: obj({ pipelineId: uuid("Pipeline.") }, ["pipelineId"]),
    readOnly: true,
    request: (a) => ({ method: "GET", url: `/api/pipelines/${enc(id(a, "pipelineId"))}` }),
  },
  {
    name: "sync_pipeline",
    title: "Sincronizar pipeline",
    description: "Relê a pipeline no provedor (parâmetros, arquivo, revisão).",
    inputSchema: obj({ pipelineId: uuid("Pipeline."), ref: str("Branch a ler (opcional).") }, ["pipelineId"]),
    readOnly: false,
    request: (a) => ({ method: "POST", url: `/api/pipelines/${enc(id(a, "pipelineId"))}/sync`, payload: pick(a, ["ref"]) }),
  },
  {
    name: "list_refs",
    title: "Listar branches e tags",
    description: "Branches e tags do repositório da pipeline.",
    inputSchema: obj({ pipelineId: uuid("Pipeline."), q: str("Filtra pelo nome.") }, ["pipelineId"]),
    readOnly: true,
    request: (a) => ({ method: "GET", url: query(`/api/pipelines/${enc(id(a, "pipelineId"))}/refs`, { q: text(a, "q") }) }),
  },

  // ----- Manifesto (configuração da pipeline no Nexo) -----
  {
    name: "list_manifest_versions",
    title: "Listar versões do manifesto",
    description: "Versões do manifesto da pipeline (a configuração dela no Nexo: parâmetros, recursos, relatórios, versão do sistema em teste).",
    inputSchema: obj({ pipelineId: uuid("Pipeline.") }, ["pipelineId"]),
    readOnly: true,
    request: (a) => ({ method: "GET", url: `/api/pipelines/${enc(id(a, "pipelineId"))}/manifest/versions` }),
  },
  {
    name: "get_manifest_version",
    title: "Ler versão do manifesto",
    description: "Conteúdo de uma versão do manifesto. Leia a versão atual antes de salvar uma nova.",
    inputSchema: obj({ pipelineId: uuid("Pipeline."), version: { type: "integer", minimum: 1 } }, ["pipelineId", "version"]),
    readOnly: true,
    request: (a) => {
      const version = a.version;
      if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new ToolArgumentError('"version" precisa ser um inteiro a partir de 1.');
      return { method: "GET", url: `/api/pipelines/${enc(id(a, "pipelineId"))}/manifest/versions/${version}` };
    },
  },
  {
    name: "save_manifest",
    title: "Salvar manifesto",
    description:
      "Grava uma nova versão do manifesto, em rascunho. expectedVersion é a versão em que a mudança se baseia: se alguém salvou antes, a gravação é recusada e é preciso reler.",
    inputSchema: obj(
      {
        pipelineId: uuid("Pipeline."),
        manifest: { type: "object", description: "Manifesto completo, no mesmo formato de get_manifest_version." },
        expectedVersion: { type: "integer", description: "Versão lida antes de editar." },
        note: str("O que mudou e por quê."),
      },
      ["pipelineId", "manifest", "expectedVersion"],
    ),
    readOnly: false,
    request: (a) => ({ method: "PUT", url: `/api/pipelines/${enc(id(a, "pipelineId"))}/manifest`, payload: pick(a, ["manifest", "expectedVersion", "note"]) }),
  },

  // ----- Arquivo da pipeline (YAML no repositório) -----
  {
    name: "get_pipeline_file",
    title: "Ler arquivo da pipeline",
    description: "YAML da pipeline no repositório, com a revisão atual (use em preview/apply).",
    inputSchema: obj({ pipelineId: uuid("Pipeline."), ref: str("Branch (opcional).") }, ["pipelineId"]),
    readOnly: true,
    request: (a) => ({ method: "GET", url: query(`/api/pipelines/${enc(id(a, "pipelineId"))}/definition`, { ref: text(a, "ref") }) }),
  },
  {
    name: "preview_pipeline_file",
    title: "Prévia de mudança no arquivo",
    description: "Diferença e problemas de sintaxe de um novo conteúdo do YAML, sem gravar nada.",
    inputSchema: obj({ pipelineId: uuid("Pipeline."), content: str("YAML completo."), ref: str("Branch (opcional).") }, ["pipelineId", "content"]),
    readOnly: true,
    request: (a) => ({
      method: "POST",
      url: `/api/pipelines/${enc(id(a, "pipelineId"))}/definition/preview`,
      payload: { content: required(a, "content"), ...pick(a, ["ref"]) },
    }),
  },
  {
    name: "apply_pipeline_file",
    title: "Gravar arquivo da pipeline",
    description:
      "Grava o YAML no repositório, por commit direto ou pull request. Só grava se o arquivo ainda estiver na expectedRevision lida. Mostre a prévia à pessoa e confirme antes.",
    inputSchema: obj(
      {
        pipelineId: uuid("Pipeline."),
        content: str("YAML completo."),
        expectedRevision: str("Revisão devolvida por get_pipeline_file."),
        mode: { type: "string", enum: ["commit", "pull-request"] },
        message: str("Mensagem do commit ou do PR."),
        ref: str("Branch (opcional)."),
      },
      ["pipelineId", "content", "expectedRevision", "mode"],
    ),
    readOnly: false,
    destructive: true,
    request: (a) => ({
      method: "POST",
      url: `/api/pipelines/${enc(id(a, "pipelineId"))}/definition`,
      payload: { content: required(a, "content"), expectedRevision: required(a, "expectedRevision"), mode: a.mode, ...pick(a, ["message", "ref"]) },
    }),
  },

  // ----- Recursos e perfis -----
  {
    name: "list_resources",
    title: "Listar recursos exclusivos",
    description: "Recursos exclusivos da organização (ambientes, bancos, dispositivos que só uma execução usa por vez), com ocupação e fila.",
    inputSchema: obj({}),
    readOnly: true,
    request: () => ({ method: "GET", url: "/api/resources" }),
  },
  {
    name: "create_resource",
    title: "Criar recurso exclusivo",
    description: "Cadastra um recurso exclusivo. O manifesto cita o recurso pelo ref.",
    inputSchema: obj(
      {
        ref: str("Identificador usado no manifesto."),
        name: str("Nome."),
        description: str("Descrição."),
        busyPolicy: { type: "string", enum: ["queue", "reject"], description: "Ocupado: espera na fila ou recusa." },
        leaseTtlSeconds: { type: "integer" },
      },
      ["ref", "name"],
    ),
    readOnly: false,
    request: (a) => ({ method: "POST", url: "/api/resources", payload: pick(a, ["ref", "name", "description", "busyPolicy", "leaseTtlSeconds"]) }),
  },
  {
    name: "list_profiles",
    title: "Listar perfis de execução",
    description: "Perfis de execução da pipeline (combinações salvas de branch e parâmetros).",
    inputSchema: obj({ pipelineId: uuid("Pipeline.") }, ["pipelineId"]),
    readOnly: true,
    request: (a) => ({ method: "GET", url: `/api/pipelines/${enc(id(a, "pipelineId"))}/profiles` }),
  },
  {
    name: "create_profile",
    title: "Criar perfil de execução",
    description: "Salva uma combinação de branch e parâmetros para executar a pipeline depois.",
    inputSchema: obj(
      { pipelineId: uuid("Pipeline."), name: str("Nome do perfil."), description: str("Descrição."), ref: str("Branch."), parameters: SCALARS },
      ["pipelineId", "name"],
    ),
    readOnly: false,
    request: (a) => ({
      method: "POST",
      url: `/api/pipelines/${enc(id(a, "pipelineId"))}/profiles`,
      payload: pick(a, ["name", "description", "ref", "parameters"]),
    }),
  },

  // ----- Execuções -----
  {
    name: "preview_execution",
    title: "Prévia de execução",
    description: "O que aconteceria ao executar agora (parâmetros resolvidos, recursos, fila), sem disparar nada.",
    inputSchema: obj({ pipelineId: uuid("Pipeline."), profileId: uuid("Perfil (opcional)."), ref: str("Branch."), parameters: SCALARS }, ["pipelineId"]),
    readOnly: true,
    request: (a) => ({ method: "POST", url: "/api/executions/preview", payload: executionBody(a) }),
  },
  {
    name: "run_pipeline",
    title: "Executar pipeline",
    description: "Dispara a pipeline no provedor. Faça a prévia e confirme com a pessoa antes.",
    inputSchema: obj(
      { pipelineId: uuid("Pipeline."), profileId: uuid("Perfil (opcional)."), ref: str("Branch."), parameters: SCALARS, idempotencyKey: str("Repetir com a mesma chave devolve a mesma execução.") },
      ["pipelineId"],
    ),
    readOnly: false,
    destructive: true,
    request: (a) => ({ method: "POST", url: "/api/executions", payload: { ...executionBody(a), ...pick(a, ["idempotencyKey"]) } }),
  },
  {
    name: "list_executions",
    title: "Listar execuções",
    description: "Histórico de execuções, filtrável por pipeline, projeto e estado.",
    inputSchema: obj({
      pipelineId: uuid("Pipeline."),
      projectId: uuid("Projeto."),
      status: str("Estados separados por vírgula."),
      limit: { type: "integer", minimum: 1, maximum: 200 },
    }),
    readOnly: true,
    request: (a) => ({
      method: "GET",
      url: query("/api/executions", {
        pipelineId: a.pipelineId === undefined ? undefined : id(a, "pipelineId"),
        projectId: a.projectId === undefined ? undefined : id(a, "projectId"),
        status: text(a, "status"),
        limit: typeof a.limit === "number" ? a.limit : undefined,
      }),
    }),
  },
  {
    name: "get_execution",
    title: "Detalhar execução",
    description: "Estado, histórico, recursos ocupados e versão do sistema em teste de uma execução.",
    inputSchema: obj({ executionId: uuid("Execução.") }, ["executionId"]),
    readOnly: true,
    request: (a) => ({ method: "GET", url: `/api/executions/${enc(id(a, "executionId"))}` }),
  },
  {
    name: "get_execution_results",
    title: "Resultados de testes",
    description: "Resultados dos testes da execução (JUnit, Playwright, k6), com as falhas.",
    inputSchema: obj({ executionId: uuid("Execução.") }, ["executionId"]),
    readOnly: true,
    request: (a) => ({ method: "GET", url: `/api/executions/${enc(id(a, "executionId"))}/results` }),
  },
  {
    name: "get_execution_logs",
    title: "Logs da execução",
    description: "Logs da execução lidos do provedor. Saídas longas voltam só com o final.",
    inputSchema: obj({ executionId: uuid("Execução.") }, ["executionId"]),
    readOnly: true,
    request: (a) => ({ method: "GET", url: `/api/executions/${enc(id(a, "executionId"))}/logs` }),
  },
  {
    name: "cancel_execution",
    title: "Cancelar execução",
    description: "Cancela uma execução em andamento no provedor.",
    inputSchema: obj({ executionId: uuid("Execução.") }, ["executionId"]),
    readOnly: false,
    destructive: true,
    request: (a) => ({ method: "POST", url: `/api/executions/${enc(id(a, "executionId"))}/cancel`, payload: {} }),
  },
];

function executionBody(a: Record<string, unknown>): Record<string, unknown> {
  return {
    pipelineId: id(a, "pipelineId"),
    ...(a.profileId === undefined ? {} : { profileId: id(a, "profileId") }),
    ...pick(a, ["ref", "parameters"]),
  };
}
