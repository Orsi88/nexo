import { describe, expect, it } from "vitest";
import { playwrightJsonProcessor, playwrightToRecords } from "../src/index.ts";

const ctx = { organizationId: "o", executionId: "e", artifactId: "a", correlationId: "c" };

// Recorte do formato do reporter "json" do Playwright.
const REPORT = {
  config: { rootDir: "/repo/tests" },
  suites: [
    {
      title: "login.spec.ts",
      file: "login.spec.ts",
      specs: [
        {
          title: "entra com senha válida",
          file: "login.spec.ts",
          tests: [
            { status: "expected", projectName: "chromium", results: [{ status: "passed", duration: 1200, retry: 0 }] },
            {
              status: "flaky",
              projectName: "firefox",
              results: [
                { status: "failed", duration: 3000, retry: 0, error: { message: "\u001b[31mTimeout 3000ms\u001b[39m\nmais", stack: "Error: Timeout\n  at login.spec.ts:12" } },
                { status: "passed", duration: 900, retry: 1 },
              ],
            },
          ],
        },
      ],
      suites: [
        {
          title: "bloqueio",
          file: "login.spec.ts",
          specs: [
            {
              title: "bloqueia após 3 tentativas",
              tests: [
                {
                  status: "unexpected",
                  projectName: "chromium",
                  results: [
                    {
                      status: "failed",
                      duration: 500,
                      errors: [{ message: "expect(locator).toBeVisible() failed" }],
                      attachments: [{ name: "screenshot", contentType: "image/png", path: "test-results/x/shot.png" }, { name: "sem-nada" }],
                    },
                  ],
                },
              ],
            },
            { title: "pulado", tests: [{ status: "skipped", projectName: "chromium", results: [{ status: "skipped", duration: 0 }] }] },
          ],
        },
      ],
    },
  ],
  errors: [],
};

describe("JSON do Playwright", () => {
  it("um teste por projeto, com situação, tentativas e erro limpo", () => {
    const records = playwrightToRecords(REPORT);
    expect(records.map((r) => [r.suite, r.name, r.project, r.status, r.attempts])).toEqual([
      ["", "entra com senha válida", "chromium", "passed", 1],
      ["", "entra com senha válida", "firefox", "flaky", 2],
      ["bloqueio", "bloqueia após 3 tentativas", "chromium", "failed", 1],
      ["bloqueio", "pulado", "chromium", "skipped", 1],
    ]);
    expect(records[1]).toMatchObject({ durationMs: 3900, errorMessage: "Timeout 3000ms", file: "login.spec.ts" });
    expect(records[1]!.errorDetails).toContain("login.spec.ts:12");
    expect(records[2]).toMatchObject({
      file: "login.spec.ts",
      errorMessage: "expect(locator).toBeVisible() failed",
      attachments: [{ name: "screenshot", contentType: "image/png", path: "test-results/x/shot.png" }],
    });
  });

  it("erros fora dos testes deixam o relatório parcial", async () => {
    const out = await playwrightJsonProcessor.process(new Blob([JSON.stringify({ ...REPORT, errors: [{ message: "SyntaxError em x.spec.ts" }] })]).stream(), ctx);
    expect(out.status).toBe("partial");
    expect(out.records).toHaveLength(4);
  });

  it("JSON inválido ou sem suítes não inventa resultado", async () => {
    expect(await playwrightJsonProcessor.process(new Blob(["{quebrado"]).stream(), ctx)).toMatchObject({ status: "failed", records: [] });
    expect(await playwrightJsonProcessor.process(new Blob(['{"config":{}}']).stream(), ctx)).toMatchObject({ status: "unsupported", records: [] });
  });
});
