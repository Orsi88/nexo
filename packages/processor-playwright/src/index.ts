import { cleanErrorText, firstLine, headText, type FunctionalTestRecord, type ProcessorOutput, type ReportProcessor } from "@painel/processor-sdk";

// Relatório JSON do reporter "json" do Playwright: { config, suites, errors, stats }.
// Cada spec tem um teste por projeto (navegador), e cada teste guarda todas as tentativas.
// Status do teste no Playwright: expected (passou como esperado), unexpected (falhou), flaky
// (falhou e passou numa nova tentativa) e skipped.

const MAX_BYTES = 100 * 1024 * 1024;

interface PwAttachment {
  name?: string;
  contentType?: string;
  path?: string;
}
interface PwResult {
  status?: string;
  duration?: number;
  retry?: number;
  error?: { message?: string; stack?: string };
  errors?: Array<{ message?: string; stack?: string }>;
  attachments?: PwAttachment[];
}
interface PwTest {
  status?: string;
  expectedStatus?: string;
  projectName?: string;
  results?: PwResult[];
}
interface PwSpec {
  title?: string;
  file?: string;
  tests?: PwTest[];
}
interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

async function readAll(input: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw new RangeError("relatório grande demais (limite de 100 MB)");
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

function statusOf(test: PwTest): FunctionalTestRecord["status"] {
  switch (test.status) {
    case "flaky":
      return "flaky";
    case "unexpected":
      return "failed";
    case "skipped":
      return "skipped";
    default: {
      // "expected": passou, ou foi pulado de propósito (test.skip / expectedStatus "skipped").
      const results = test.results ?? [];
      return test.expectedStatus === "skipped" || (results.length > 0 && results.every((r) => r.status === "skipped")) ? "skipped" : "passed";
    }
  }
}

/** Converte o JSON do Playwright em testes normalizados. */
export function playwrightToRecords(report: { suites?: PwSuite[] }): FunctionalTestRecord[] {
  const out: FunctionalTestRecord[] = [];
  const walk = (suite: PwSuite, path: string[], file: string | undefined) => {
    const ownFile = suite.file ?? file;
    // A suíte de primeiro nível tem como título o próprio arquivo: não entra no caminho.
    const titles = suite.title && suite.title !== suite.file ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const status = statusOf(test);
        const record: FunctionalTestRecord = {
          suite: titles.join(" › "),
          name: spec.title ?? "(sem nome)",
          status,
          attempts: Math.max(1, results.length),
        };
        const f = spec.file ?? ownFile;
        if (f) record.file = f;
        if (test.projectName) record.project = test.projectName;
        const duration = results.reduce((sum, r) => sum + (typeof r.duration === "number" && r.duration > 0 ? r.duration : 0), 0);
        if (duration > 0) record.durationMs = Math.round(duration);
        if (status === "failed" || status === "flaky") {
          // A tentativa que explica a falha: a última que falhou.
          const failing = [...results].reverse().find((r) => r.status && r.status !== "passed" && r.status !== "skipped");
          const error = failing?.error ?? failing?.errors?.[0];
          const title = firstLine(error?.message);
          const details = cleanErrorText(error?.stack ?? error?.message);
          if (title) record.errorMessage = title;
          if (details) record.errorDetails = details;
          const attachments = (failing?.attachments ?? [])
            .filter((a) => a.name && (a.path || a.contentType))
            .slice(0, 20)
            .map((a) => ({ name: a.name!, ...(a.contentType ? { contentType: a.contentType } : {}), ...(a.path ? { path: a.path } : {}) }));
          if (attachments.length) record.attachments = attachments;
        }
        out.push(record);
      }
    }
    for (const child of suite.suites ?? []) walk(child, titles, ownFile);
  };
  for (const suite of report.suites ?? []) walk(suite, [], undefined);
  return out;
}

/** Relatório JSON do reporter "json" do Playwright: objeto com "config" e "suites". */
export const playwrightJsonProcessor: ReportProcessor = {
  id: "playwright-json@1",
  category: "functional",
  detect(artifact, head) {
    const text = headText(head);
    const isJson = artifact.name.endsWith(".json") || artifact.contentType === "application/json";
    const matches = isJson && text.startsWith("{") && text.includes('"config"') && text.includes('"suites"');
    return { matches, confidence: matches ? 0.9 : 0 };
  },
  async process(input): Promise<ProcessorOutput> {
    let report: unknown;
    try {
      report = JSON.parse(await readAll(input));
    } catch (error) {
      return { status: "failed", reason: `JSON do Playwright inválido: ${error instanceof Error ? error.message.slice(0, 200) : "erro"}`, records: [] };
    }
    if (!report || typeof report !== "object" || !Array.isArray((report as { suites?: unknown }).suites)) {
      return { status: "unsupported", reason: "o JSON não tem a lista de suítes do Playwright", records: [] };
    }
    const records = playwrightToRecords(report as { suites: PwSuite[] });
    // Erros globais (ex.: falha ao carregar um arquivo de teste) tornam o relatório parcial.
    const globalErrors = (report as { errors?: unknown[] }).errors;
    if (Array.isArray(globalErrors) && globalErrors.length) {
      return { status: "partial", reason: `${globalErrors.length} erro(s) fora dos testes (ex.: arquivo que não carregou)`, records };
    }
    return records.length ? { status: "processed", records } : { status: "processed", reason: "relatório sem nenhum teste", records };
  },
};

/**
 * Relatório HTML do Playwright: não é normalizado, só preservado e servido na origem isolada
 * (RF-087, RF-088, RNF-024). Por isso o processamento é "processed" sem registros.
 */
export const playwrightHtmlProcessor: ReportProcessor = {
  id: "playwright-html@1",
  category: "functional",
  detect(artifact, head) {
    const text = headText(head).toLowerCase();
    const matches = artifact.name.endsWith(".html") && text.startsWith("<!doctype html") && text.includes("playwright");
    return { matches, confidence: matches ? 0.6 : 0 };
  },
  async process() {
    return { status: "processed", reason: "HTML preservado para o visualizador isolado", records: [] };
  },
};
