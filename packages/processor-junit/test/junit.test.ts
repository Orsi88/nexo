import { describe, expect, it } from "vitest";
import { junitToRecords, junitXmlProcessor, parseXml } from "../src/index.ts";

const ctx = { organizationId: "o", executionId: "e", artifactId: "a", correlationId: "c" };
const stream = (s: string) => new Blob([s]).stream();

// Formato do reporter junit do "node --test": suítes aninhadas, falha com texto.
const NODE_TEST = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="parser" tests="3" failures="1" skipped="1" time="0.05">
    <testcase name="lê o cabeçalho" time="0.012" classname="test" file="test/parser.test.ts"/>
    <testcase name="rejeita &lt;DOCTYPE&gt;" time="0.003" classname="test" file="test/parser.test.ts">
      <failure type="testCodeFailure" message="Expected values to be strictly equal:&#10;&#10;1 !== 2">
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    at TestContext.&lt;anonymous&gt; (test/parser.test.ts:10:5)
      </failure>
    </testcase>
    <testcase name="ainda não feito" time="0" classname="test"><skipped type="skipped"/></testcase>
  </testsuite>
  <testcase name="solto no topo" time="1.5" classname="raiz"/>
</testsuites>`;

describe("JUnit XML", () => {
  it("converte casos em testes normalizados", () => {
    const records = junitToRecords(parseXml(NODE_TEST));
    expect(records).toHaveLength(4);
    expect(records[0]).toEqual({ suite: "parser", name: "lê o cabeçalho", file: "test/parser.test.ts", status: "passed", attempts: 1, durationMs: 12 });
    expect(records[1]).toMatchObject({ name: "rejeita <DOCTYPE>", status: "failed", errorMessage: "Expected values to be strictly equal:" });
    expect(records[1]!.errorDetails).toContain("test/parser.test.ts:10:5");
    expect(records[2]).toMatchObject({ status: "skipped", durationMs: 0 });
    // Sem suíte em volta: usa o classname.
    expect(records[3]).toMatchObject({ suite: "raiz", durationMs: 1500, status: "passed" });
  });

  it("caso que passou numa nova tentativa é instável (Surefire)", () => {
    const xml = `<testsuite name="s"><testcase name="t" classname="c" time="2">
      <flakyFailure message="timeout"><![CDATA[stack 1]]></flakyFailure>
      <flakyFailure message="timeout de novo">stack 2</flakyFailure>
    </testcase></testsuite>`;
    expect(junitToRecords(parseXml(xml))).toEqual([
      { suite: "s", name: "t", status: "flaky", attempts: 3, durationMs: 2000, errorMessage: "timeout", errorDetails: "stack 1" },
    ]);
  });

  it("processa o fluxo e diz quando o relatório não tem testes", async () => {
    const ok = await junitXmlProcessor.process(stream(NODE_TEST), ctx);
    expect(ok.status).toBe("processed");
    expect(ok.records).toHaveLength(4);
    const empty = await junitXmlProcessor.process(stream("<testsuites/>"), ctx);
    expect(empty).toMatchObject({ status: "processed", reason: "relatório sem nenhum teste", records: [] });
  });

  it("recusa DOCTYPE (entidades externas) e XML quebrado", async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><testsuite>&e;</testsuite>`;
    expect(await junitXmlProcessor.process(stream(xxe), ctx)).toMatchObject({ status: "failed", records: [] });
    expect(await junitXmlProcessor.process(stream("<testsuite><testcase></testsuite>"), ctx)).toMatchObject({ status: "failed" });
  });

  it("raiz que não é de JUnit fica como não suportada", async () => {
    expect(await junitXmlProcessor.process(stream("<coverage/>"), ctx)).toMatchObject({ status: "unsupported" });
  });
});
