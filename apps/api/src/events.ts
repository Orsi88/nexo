import type pg from "pg";
import { EVENTS_CHANNEL, parseEvent, type PlatformEvent } from "@painel/core";

// Ponte entre o banco e o SSE (ADR-010): uma conexão escuta o canal (LISTEN) e repassa cada evento
// só a quem está na mesma organização. Se a conexão cair, reconecta sozinha.

type Listener = (event: PlatformEvent) => void;

export class EventHub {
  readonly #pool: pg.Pool;
  readonly #listeners = new Map<string, Set<Listener>>();
  #client: pg.PoolClient | undefined;
  #closed = false;
  #log: (msg: string, error?: unknown) => void;

  constructor(pool: pg.Pool, log: (msg: string, error?: unknown) => void = () => undefined) {
    this.#pool = pool;
    this.#log = log;
  }

  async start(): Promise<void> {
    if (this.#closed) return;
    try {
      const client = await this.#pool.connect();
      client.on("notification", (msg) => {
        if (msg.channel !== EVENTS_CHANNEL) return;
        const event = parseEvent(msg.payload);
        if (!event) return;
        for (const l of this.#listeners.get(event.organizationId) ?? []) l(event);
      });
      client.on("error", (error) => {
        this.#log("conexão de eventos caiu", error);
        this.#drop(client);
        setTimeout(() => void this.start(), 3000);
      });
      await client.query(`LISTEN ${EVENTS_CHANNEL}`);
      this.#client = client;
    } catch (error) {
      this.#log("não foi possível escutar eventos", error);
      setTimeout(() => void this.start(), 5000);
    }
  }

  subscribe(organizationId: string, listener: Listener): () => void {
    let set = this.#listeners.get(organizationId);
    if (!set) this.#listeners.set(organizationId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.#listeners.delete(organizationId);
    };
  }

  async stop(): Promise<void> {
    this.#closed = true;
    if (this.#client) this.#drop(this.#client);
  }

  #drop(client: pg.PoolClient) {
    if (this.#client === client) this.#client = undefined;
    try {
      client.release(true);
    } catch {
      /* já liberada */
    }
  }
}
