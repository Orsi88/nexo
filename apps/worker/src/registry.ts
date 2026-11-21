import { createAzureDevOpsConnector } from "@painel/connector-azure-devops";
import { createGitHubConnector } from "@painel/connector-github";
import { ConnectorRegistry } from "@painel/connector-sdk";
import { junitXmlProcessor } from "@painel/processor-junit";
import { k6SummaryProcessor } from "@painel/processor-k6";
import { playwrightHtmlProcessor, playwrightJsonProcessor } from "@painel/processor-playwright";
import { ProcessorRegistry } from "@painel/processor-sdk";

/** Conectores e processadores desta instalação. Um provedor novo entra aqui, sem mudar o núcleo (§15). */
export function buildRegistries(options: { azureDevOpsExtraHosts?: string[]; gitHubExtraHosts?: string[] } = {}) {
  const connectors = new ConnectorRegistry();
  connectors.register(createAzureDevOpsConnector({ extraHosts: options.azureDevOpsExtraHosts ?? [] }));
  connectors.register(createGitHubConnector({ extraHosts: options.gitHubExtraHosts ?? [] }));

  const processors = new ProcessorRegistry();
  for (const p of [playwrightJsonProcessor, playwrightHtmlProcessor, junitXmlProcessor, k6SummaryProcessor]) {
    processors.register(p);
  }
  return { connectors, processors };
}
