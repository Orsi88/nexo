import type pg from "pg";

/** Contexto que o banco recebe em cada transação, para as políticas de RLS (ADR-003). */
export interface DbScope {
  organizationId?: string | null;
  userId?: string | null;
}

export type Sql = Pick<pg.PoolClient, "query">;

export interface DatabaseOptions {
  /**
   * Papel assumido em cada transação (SET LOCAL ROLE). Em produção a conexão já é de um usuário
   * membro de painel_app e isto fica vazio; nos testes a conexão é administrativa e assume painel_app.
   */
  role?: string;
}

/**
 * Acesso ao PostgreSQL. Toda leitura e escrita da aplicação passa por `tx`, que abre uma transação e
 * define `app.organization_id` e `app.user_id` só para ela (set_config local), então o contexto nunca
 * vaza entre requisições que compartilham a mesma conexão do pool.
 */
export class Database {
  readonly pool: pg.Pool;
  private readonly role: string | undefined;

  constructor(pool: pg.Pool, options: DatabaseOptions = {}) {
    this.pool = pool;
    if (options.role && !/^[a-z_][a-z0-9_]*$/.test(options.role)) throw new Error("nome de papel inválido");
    this.role = options.role;
  }

  async tx<T>(scope: DbScope, fn: (sql: Sql) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (this.role) await client.query(`SET LOCAL ROLE ${this.role}`);
      await client.query("SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)", [
        scope.organizationId ?? "",
        scope.userId ?? "",
      ]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Muda o tenant dentro de uma transação já aberta (ex.: criar uma organização e gravar nela). */
  static async setOrganization(sql: Sql, organizationId: string | null): Promise<void> {
    await sql.query("SELECT set_config('app.organization_id', $1, true)", [organizationId ?? ""]);
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}

/** Código de erro de violação de unicidade do PostgreSQL. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}
