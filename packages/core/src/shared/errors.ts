/**
 * Erros de domínio com código estável. A api traduz o código em status HTTP; a mensagem é segura
 * para mostrar ao usuário e nunca carrega segredos (RNF-033).
 */
export type DomainErrorCode =
  | "invalid" // entrada inválida (400)
  | "unauthenticated" // sem sessão válida (401)
  | "forbidden" // sessão válida, papel sem permissão (403)
  | "not-found" // inexistente ou de outra organização: as duas respostas são iguais (404)
  | "conflict" // estado não permite a operação (409)
  | "rate-limited" // tentativas demais (429)
  | "provider"; // o provedor externo falhou ou recusou a credencial guardada (502)

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new DomainError("not-found", `${what} não encontrado(a)`);
