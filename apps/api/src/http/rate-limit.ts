/**
 * Limite simples por chave em janela fixa de um minuto, em memória e por instância.
 * Complementa o bloqueio por conta guardado no banco (RNF-026); não substitui um limite no proxy.
 */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** true = pode seguir. */
  take(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      if (this.hits.size > 10_000) this.sweep(now);
      this.hits.set(key, { windowStart: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  private sweep(now: number) {
    for (const [key, entry] of this.hits) if (now - entry.windowStart >= this.windowMs) this.hits.delete(key);
  }
}
