import type { PipelineConnector } from "./connector.ts";

/** Registro dos conectores disponíveis na instalação (RF-013, RF-024). */
export class ConnectorRegistry {
  #connectors = new Map<string, PipelineConnector>();

  register(connector: PipelineConnector): void {
    if (this.#connectors.has(connector.kind)) {
      throw new Error(`conector já registrado: ${connector.kind}`);
    }
    this.#connectors.set(connector.kind, connector);
  }

  get(kind: string): PipelineConnector {
    const connector = this.#connectors.get(kind);
    if (!connector) throw new Error(`conector desconhecido: ${kind}`);
    return connector;
  }

  kinds(): string[] {
    return [...this.#connectors.keys()].sort();
  }
}
