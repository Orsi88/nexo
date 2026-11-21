import { useState } from "react";
import { NewIntegrationDialog } from "./Forms.tsx";
import { useApp } from "../context.tsx";
import { Icon } from "../icons.tsx";
import { ago, dateTime, Failure, PageSkeleton, Paged, useAsync } from "../util.tsx";

// Integrações e auditoria: seções da tela de Administração (Settings.tsx, AdminScreen).

export function Integrations() {
  const { data, version } = useApp();
  const result = useAsync(() => data.integrations(), [data, version]);
  const [creating, setCreating] = useState(false);

  if (result.state === "loading") return <PageSkeleton />;
  if (result.state === "error") return <Failure error={result.error} />;
  return (
    <>
      <div className="admin-toolbar">
        <span className="secondary">
          Conexões com os provedores de CI/CD. A credencial é testada antes de ser guardada, fica cifrada e nenhuma tela a mostra de novo: para
          trocar, cadastre outra.
        </span>
        <button className="btn primary" type="button" onClick={() => setCreating(true)}>
          <Icon name="plus" size={15} />
          Nova integração
        </button>
      </div>
      {creating ? <NewIntegrationDialog onClose={() => setCreating(false)} onCreated={() => setCreating(false)} /> : null}
      {result.value.length === 0 ? (
        <div className="empty">Nenhuma integração ainda. Cadastre o Azure DevOps com um PAT para descobrir as pipelines.</div>
      ) : (
        <div className="grid two">
          {result.value.map((i) => (
            <section className="card" key={i.id}>
              <div className="card-title">
                <Icon name="plug" size={16} />
                <span>{i.name}</span>
                <span className="grow" />
                {i.status === "ok" ? (
                  <span className="quiet">
                    <Icon name="check" size={12} />
                    conectada
                  </span>
                ) : (
                  <span className="badge critical">
                    <Icon name="alert" size={12} />
                    {i.status === "failing" ? "Falhando" : "Não testada"}
                  </span>
                )}
              </div>
              <dl className="kv">
                <dt>Provedor</dt>
                <dd>{i.kind === "azure-devops" ? "Azure DevOps" : i.kind === "github" ? "GitHub Actions" : i.kind}</dd>
                <dt>Endereço</dt>
                <dd className="mono">{i.endpoint}</dd>
                <dt>Credencial</dt>
                <dd>
                  <Icon name="key" size={13} /> PAT guardado cifrado · trocado {ago(i.credentialUpdatedAt)}
                </dd>
                <dt>Último teste</dt>
                <dd>
                  {dateTime(i.lastCheckedAt)}
                  {i.lastCheck?.message ? ` · ${i.lastCheck.message}` : ""}
                </dd>
              </dl>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

const ACTION_LABEL: Record<string, string> = {
  "integration.create": "Cadastrou integração",
  "integration.test": "Testou integração",
  "integration.credential.rotate": "Trocou a credencial",
  "pipeline.import": "Vinculou pipeline",
  "pipeline.sync": "Sincronizou pipeline",
  "pipeline.manifest.save": "Salvou o manifesto",
  "pipeline.manifest.import": "Importou manifesto",
  "member.invite": "Convidou membro",
};

export function Audit() {
  const { data, version } = useApp();
  const result = useAsync(() => data.audit(), [data, version]);
  if (result.state === "loading") return <PageSkeleton />;
  if (result.state === "error") return <Failure error={result.error} />;
  return (
    <>
      <Paged items={result.value}>
        {(page, pager) => (
          <div className="card flush">
            <table className="list">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Ação</th>
                  <th>Resultado</th>
                  <th>Alvo</th>
                </tr>
              </thead>
              <tbody>
                {page.map((e) => (
                  <tr key={e.id}>
                    <td>{dateTime(e.occurredAt)}</td>
                    <td>
                      {ACTION_LABEL[e.action] ?? e.action}
                      <div className="secondary mono">{e.action}</div>
                    </td>
                    <td>
                      {e.outcome === "success" ? (
                        <span className="quiet">
                          <Icon name="check" size={12} />
                          sucesso
                        </span>
                      ) : (
                        <span className="badge critical">
                          <Icon name="x" size={12} />
                          {e.outcome === "denied" ? "Negado" : "Falhou"}
                        </span>
                      )}
                    </td>
                    <td className="mono">{e.targetType}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pager}
          </div>
        )}
      </Paged>
    </>
  );
}
