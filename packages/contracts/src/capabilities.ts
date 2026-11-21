import { z } from "zod";

// Cada conector declara o que realmente suporta (RN-024, RN-044, §10.1, §18.2).
// Nada é simulado: um método opcional ausente corresponde a uma capacidade "false".

export const ConnectorCapabilitiesSchema = z
  .object({
    read: z
      .object({
        pipelines: z.boolean(),
        parameters: z.boolean(),
        runs: z.boolean(),
        logs: z.boolean(),
        artifacts: z.boolean(),
        schedules: z.boolean(),
        definition: z.boolean(),
      })
      .strict(),
    write: z
      .object({
        triggerRun: z.boolean(),
        cancelRun: z.boolean(),
        definitionViaApi: z.boolean(),
        definitionViaCommit: z.boolean(),
        definitionViaPullRequest: z.boolean(),
      })
      .strict(),
    events: z.object({ webhooks: z.boolean() }).strict(),
  })
  .strict();

export type ConnectorCapabilities = z.infer<typeof ConnectorCapabilitiesSchema>;

export const NO_CAPABILITIES: ConnectorCapabilities = {
  read: {
    pipelines: false,
    parameters: false,
    runs: false,
    logs: false,
    artifacts: false,
    schedules: false,
    definition: false,
  },
  write: {
    triggerRun: false,
    cancelRun: false,
    definitionViaApi: false,
    definitionViaCommit: false,
    definitionViaPullRequest: false,
  },
  events: { webhooks: false },
};
