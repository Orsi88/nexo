import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResultsService } from "@painel/core";
import { actorOf, IdParams, parse } from "./foundation.ts";

// Resultados de testes de uma execução (incremento 5): resumo, artefatos, relatórios e testes.

const ResultsQuery = z.object({
  status: z.string().max(60).optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

const PerfQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });

export function registerResultsRoutes(app: FastifyInstance, svc: ResultsService): void {
  app.get("/api/executions/:id/results", async (req) => svc.executionResults(actorOf(req), parse(IdParams, req.params).id, parse(ResultsQuery, req.query)));
  // Desempenho (incremento 6): série histórica por pipeline, separada dos testes funcionais.
  app.get("/api/pipelines/:id/performance", async (req) => ({
    items: await svc.pipelinePerformance(actorOf(req), parse(IdParams, req.params).id, parse(PerfQuery, req.query).limit),
  }));
}
