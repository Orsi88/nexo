import { cleanErrorText, firstLine, headText, type FunctionalTestRecord, type ReportProcessor } from "@painel/processor-sdk";
import { parseXml, XmlParseError, type XmlElement } from "./xml.ts";

export { parseXml, XmlParseError } from "./xml.ts";

// JUnit XML: o formato comum de quase todo runner (node --test, vitest, Jest, pytest, Maven
// Surefire...). Cada <testcase> vira um teste; <failure>/<error> = falhou, <skipped> = pulado;
// <flakyFailure>/<rerunFailure> num caso que passou = instável (passou numa nova tentativa).

const MAX_BYTES = 50 * 1024 * 1024;

async function readAll(input: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw new XmlParseError("relatório grande demais (limite de 50 MB)");
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

const seconds = (value: string | undefined) => {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : undefined;
};

/** Converte a árvore do JUnit em testes normalizados. */
export function junitToRecords(root: XmlElement): FunctionalTestRecord[] {
  const out: FunctionalTestRecord[] = [];
  const walk = (el: XmlElement, suite: string | undefined, file: string | undefined) => {
    if (el.name === "testcase") {
      const failure = el.children.find((c) => c.name === "failure" || c.name === "error");
      const skipped = el.children.some((c) => c.name === "skipped");
      const reruns = el.children.filter((c) => /^(flaky|rerun)(Failure|Error)$/.test(c.name));
      const status: FunctionalTestRecord["status"] = failure ? "failed" : skipped ? "skipped" : reruns.length ? "flaky" : "passed";
      const errorSource = failure ?? reruns[0];
      const message = errorSource?.attrs.message ?? errorSource?.text;
      const record: FunctionalTestRecord = {
        suite: suite ?? el.attrs.classname ?? "",
        name: el.attrs.name ?? "(sem nome)",
        status,
        attempts: 1 + reruns.length,
      };
      const testFile = el.attrs.file ?? file;
      if (testFile) record.file = testFile;
      const ms = seconds(el.attrs.time);
      if (ms !== undefined) record.durationMs = ms;
      if (status === "failed" || status === "flaky") {
        const title = firstLine(message);
        const details = cleanErrorText(errorSource?.text || message);
        if (title) record.errorMessage = title;
        if (details) record.errorDetails = details;
      }
      out.push(record);
      return;
    }
    const isSuite = el.name === "testsuite";
    const nextSuite = isSuite ? (el.attrs.name ?? suite) : suite;
    const nextFile = isSuite ? (el.attrs.file ?? file) : file;
    for (const child of el.children) walk(child, nextSuite, nextFile);
  };
  walk(root, undefined, undefined);
  return out;
}

/** JUnit XML: raiz <testsuites> ou <testsuite>, com ou sem declaração XML antes. */
export const junitXmlProcessor: ReportProcessor = {
  id: "junit-xml@1",
  category: "functional",
  detect(_artifact, head) {
    const text = headText(head)
      .replace(/^<\?xml[^>]*\?>\s*/, "")
      .replace(/^(<!--[\s\S]*?-->\s*)+/, "");
    const matches = /^<testsuites?[\s>]/.test(text);
    return { matches, confidence: matches ? 0.8 : 0 };
  },
  async process(input) {
    try {
      const root = parseXml(await readAll(input));
      if (root.name !== "testsuites" && root.name !== "testsuite") {
        return { status: "unsupported", reason: `raiz <${root.name}> não é de um relatório JUnit`, records: [] };
      }
      const records = junitToRecords(root);
      return records.length ? { status: "processed", records } : { status: "processed", reason: "relatório sem nenhum teste", records };
    } catch (error) {
      if (error instanceof XmlParseError) return { status: "failed", reason: `JUnit inválido: ${error.message}`, records: [] };
      throw error;
    }
  },
};
