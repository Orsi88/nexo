import type { ProcessingStatus, ResultCategory } from "@painel/contracts";

// Contrato dos processadores de relatório (ADR-006, RNF-022, RNF-031, §20.3).
// O artefato original é sempre preservado pela plataforma; o processador só lê.
// Reprocessar é idempotente pela chave (execução, artefato, processador@versão).

export interface ArtifactMeta {
  name: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface DetectResult {
  matches: boolean;
  /** 0 a 1: com mais de um processador compatível, vence o de maior confiança. */
  confidence: number;
}

export interface ProcessorContext {
  organizationId: string;
  executionId: string;
  artifactId: string;
  correlationId: string;
}

export interface ProcessorOutput {
  status: Exclude<ProcessingStatus, "pending" | "processing">;
  /** Motivo legível quando o status não é "processed". */
  reason?: string;
  /** Registros normalizados da categoria do processador; o formato é definido por categoria. */
  records: unknown[];
}

/**
 * Um teste funcional normalizado (categoria "functional"), igual para todo formato de origem
 * (JUnit, Playwright JSON...). "flaky" = falhou e passou numa nova tentativa (RN-013).
 */
export interface FunctionalTestRecord {
  suite: string;
  name: string;
  file?: string;
  /** Projeto ou navegador (Playwright), quando o formato informa. */
  project?: string;
  status: "passed" | "failed" | "skipped" | "flaky";
  durationMs?: number;
  /** Quantas vezes o teste rodou (1 = sem nova tentativa). */
  attempts: number;
  /** Primeira linha útil do erro, curta. */
  errorMessage?: string;
  /** Detalhe do erro (pilha, diff), cortado num tamanho seguro. */
  errorDetails?: string;
  /** Evidências citadas pelo relatório (prints, vídeos, traces), pelo caminho dentro do artefato. */
  attachments?: Array<{ name: string; contentType?: string; path?: string }>;
}

/** Métrica de desempenho como a ferramenta informou (k6: trend, rate, counter, gauge). */
export interface PerformanceMetric {
  name: string;
  type: "trend" | "rate" | "counter" | "gauge";
  /** "time" = milissegundos; "data" = bytes; "default" = número puro. */
  contains: "time" | "data" | "default";
  values: Record<string, number>;
}

export interface PerformanceThreshold {
  metric: string;
  expression: string;
  ok: boolean;
}

/**
 * Resultado de desempenho normalizado (categoria "performance"), um por arquivo de resumo.
 * Nunca vira "teste aprovado/reprovado": requisições HTTP não são testes (RN-045, §20.2).
 * Unidades: latência em ms, taxas como proporção (0 a 1), vazão por segundo na janela durationMs.
 */
export interface PerformanceRecord {
  format: string;
  durationMs?: number;
  vusMax?: number;
  iterations?: number;
  httpReqs?: number;
  httpReqRate?: number;
  httpReqFailedRate?: number;
  latency: { avg?: number; med?: number; p90?: number; p95?: number; p99?: number; max?: number };
  checksRate?: number;
  metrics: PerformanceMetric[];
  thresholds: PerformanceThreshold[];
}

/** Corta texto de erro num tamanho seguro e sem códigos de cor do terminal. */
export function cleanErrorText(text: string | undefined, max = 4000): string | undefined {
  if (!text) return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n/g, "\n").trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max)}\n…` : clean;
}

/** Primeira linha não vazia de um texto de erro (o "título" da falha). */
export function firstLine(text: string | undefined, max = 300): string | undefined {
  const line = cleanErrorText(text)?.split("\n").find((l) => l.trim());
  return line ? line.trim().slice(0, max) : undefined;
}

export interface ReportProcessor {
  /** Identificador estável com versão, por exemplo "playwright-json@1". */
  readonly id: string;
  readonly category: ResultCategory;
  detect(artifact: ArtifactMeta, head: Uint8Array): DetectResult;
  process(input: ReadableStream<Uint8Array>, ctx: ProcessorContext): Promise<ProcessorOutput>;
}

/** Escolhe o processador mais confiável para um artefato, ou nenhum (artefato preservado como "unsupported"). */
export class ProcessorRegistry {
  #processors: ReportProcessor[] = [];

  register(processor: ReportProcessor): void {
    if (this.#processors.some((p) => p.id === processor.id)) {
      throw new Error(`processador já registrado: ${processor.id}`);
    }
    this.#processors.push(processor);
  }

  select(artifact: ArtifactMeta, head: Uint8Array): ReportProcessor | undefined {
    let best: { processor: ReportProcessor; confidence: number } | undefined;
    for (const processor of this.#processors) {
      const result = processor.detect(artifact, head);
      if (result.matches && (!best || result.confidence > best.confidence)) {
        best = { processor, confidence: result.confidence };
      }
    }
    return best?.processor;
  }
}

/** Lê o início de um artefato como texto, para detecção por conteúdo (trimStart também remove o BOM). */
export function headText(head: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(head).trimStart();
}

/** Resposta padrão de um processador ainda não implementado: honesta, sem inventar resultados (RN-012). */
export function notImplementedOutput(id: string): ProcessorOutput {
  return { status: "unsupported", reason: `${id}: processamento ainda não implementado`, records: [] };
}
