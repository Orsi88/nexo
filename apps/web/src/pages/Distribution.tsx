import { useState } from "react";
import { useApp } from "../context.tsx";
import type { EmailHistoryItem, OrgSettings } from "../data/types.ts";
import { Icon } from "../icons.tsx";
import { dateTime, Failure, PageSkeleton, SettingLine, Switch, UnitInput, useAsync } from "../util.tsx";
import { ShareLinksList } from "./Share.tsx";

// Administração do incremento 7: política de links compartilhados, retenção e e-mail.
// Toda regra é do servidor; a tela só mostra e repassa (só o admin da organização salva políticas).

function useSettingsForm() {
  const { data, version, session, notify, refresh } = useApp();
  const result = useAsync(() => data.orgSettings(), [data, version]);
  const [draft, setDraft] = useState<OrgSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = session.organization?.role === "admin";
  const current = draft ?? (result.state === "ready" ? result.value : null);
  const dirty = draft !== null && result.state === "ready" && JSON.stringify(draft) !== JSON.stringify(result.value);
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await data.saveOrgSettings(draft);
      notify("Política salva.");
      setDraft(null);
      refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Não foi possível salvar.", "error");
    } finally {
      setBusy(false);
    }
  };
  return { result, current, setDraft, dirty, busy, save, isAdmin };
}

/** Rodapé do cartão de política: só aparece com mudança pendente (ou o aviso para quem não é admin). */
function SettingsFoot({ dirty, busy, onDiscard, onSave, isAdmin }: { dirty: boolean; busy: boolean; onDiscard: () => void; onSave: () => void; isAdmin: boolean }) {
  if (!isAdmin) return <div className="settings-foot muted small-print">Só o admin da organização muda esta política.</div>;
  if (!dirty) return null;
  return (
    <div className="settings-foot">
      <button className="btn" type="button" disabled={busy} onClick={onDiscard}>
        Descartar
      </button>
      <button className="btn primary" type="button" disabled={busy} onClick={onSave}>
        Salvar
      </button>
    </div>
  );
}

/** Política de links e a lista de links da organização. */
export function SharingTab() {
  const f = useSettingsForm();
  if (f.result.state === "loading") return <PageSkeleton />;
  if (f.result.state === "error") return <Failure error={f.result.error} />;
  const s = f.current!;
  const set = (sharing: Partial<OrgSettings["sharing"]>) => f.setDraft({ ...s, sharing: { ...s.sharing, ...sharing } });
  return (
    <div className="admin-stack">
      <section className="card settings-card">
        <div className="card-title">
          <Icon name="share" size={15} />
          Política
        </div>
        <p className="settings-intro">O visitante só lê o que foi publicado. Tokens, senhas e e-mails que aparecem nos textos são mascarados.</p>
        <SettingLine title="Links públicos" description="Abrem sem entrar no Nexo. Desligado, só valem links para membros, e os públicos já criados param de abrir.">
          <Switch label="Permitir links públicos" checked={s.sharing.allowPublic} disabled={!f.isAdmin} onChange={(v) => set({ allowPublic: v })} />
        </SettingLine>
        <SettingLine title="Validade sugerida" description="O valor que aparece ao criar um link.">
          <UnitInput label="Validade sugerida em dias" unit="dias" value={s.sharing.defaultDays} min={1} max={s.sharing.maxDays} disabled={!f.isAdmin} onChange={(v) => set({ defaultDays: v })} />
        </SettingLine>
        <SettingLine title="Validade máxima" description="Todo link expira: não existe link eterno.">
          <UnitInput
            label="Validade máxima em dias"
            unit="dias"
            value={s.sharing.maxDays}
            min={1}
            max={365}
            disabled={!f.isAdmin}
            onChange={(v) => set({ maxDays: v, defaultDays: Math.min(v, s.sharing.defaultDays) })}
          />
        </SettingLine>
        <SettingsFoot dirty={f.dirty} busy={f.busy} isAdmin={f.isAdmin} onDiscard={() => f.setDraft(null)} onSave={() => void f.save()} />
      </section>
      <div className="section" style={{ marginTop: 6 }}>
        <h2>Links criados</h2>
        <ShareLinksList />
      </div>
    </div>
  );
}

/** Retenção por tipo de dado (22.1). */
export function RetentionTab() {
  const f = useSettingsForm();
  if (f.result.state === "loading") return <PageSkeleton />;
  if (f.result.state === "error") return <Failure error={f.result.error} />;
  const s = f.current!;
  const set = (retention: Partial<OrgSettings["retention"]>) => f.setDraft({ ...s, retention: { ...s.retention, ...retention } });
  return (
    <div className="admin-stack">
      <section className="card settings-card">
        <div className="card-title">
          <Icon name="clock" size={15} />
          Por quanto tempo guardar
        </div>
        <p className="settings-intro">
          Aplicada de hora em hora. O histórico das execuções (o que rodou e como terminou) fica sempre. Os logs não são guardados pelo Nexo: são lidos do provedor
          na hora.
        </p>
        <SettingLine title="Artefatos originais" description="Relatórios, prints, vídeos e traces publicados pela pipeline. O registro fica, marcado como expirado.">
          <UnitInput label="Artefatos originais em dias" unit="dias" value={s.retention.artifactsDays} min={1} max={3650} disabled={!f.isAdmin} onChange={(v) => set({ artifactsDays: v })} />
        </SettingLine>
        <SettingLine title="Testes e métricas detalhados" description="Lista de testes, erros e métricas do k6. O resumo da execução continua.">
          <UnitInput label="Testes e métricas em dias" unit="dias" value={s.retention.resultsDays} min={30} max={3650} disabled={!f.isAdmin} onChange={(v) => set({ resultsDays: v })} />
        </SettingLine>
        <SettingLine title="Histórico de e-mails" description="Quem recebeu o quê, e as falhas de envio.">
          <UnitInput label="Histórico de e-mails em dias" unit="dias" value={s.retention.emailsDays} min={1} max={3650} disabled={!f.isAdmin} onChange={(v) => set({ emailsDays: v })} />
        </SettingLine>
        <SettingsFoot dirty={f.dirty} busy={f.busy} isAdmin={f.isAdmin} onDiscard={() => f.setDraft(null)} onSave={() => void f.save()} />
      </section>
    </div>
  );
}

const KIND_LABEL: Record<EmailHistoryItem["kind"], string> = { rule: "Aviso", invite: "Convite", "password-reset": "Redefinição de senha", test: "Teste" };
const MAIL_STATUS: Record<EmailHistoryItem["status"], { label: string; badge: string }> = {
  pending: { label: "Na fila", badge: "warning" },
  sent: { label: "Enviado", badge: "good" },
  failed: { label: "Falhou", badge: "critical" },
};

/** Situação do SMTP, teste de envio e histórico (RF-130). */
export function EmailTab() {
  const { data, version, notify, refresh, session } = useApp();
  const canConfigure = Boolean(session.organization?.permissions.configurePipelines);
  const result = useAsync(async () => ({ status: await data.emailStatus(), history: canConfigure ? await data.emailHistory() : [] }), [data, version, canConfigure]);
  const [busy, setBusy] = useState(false);
  if (result.state === "loading") return <PageSkeleton />;
  if (result.state === "error") return <Failure error={result.error} />;
  const { status, history } = result.value;
  return (
    <div className="admin-stack">
      <section className="card">
        <div className="card-title">
          <Icon name="mail" size={15} />
          Envio de e-mails
        </div>
        {status.enabled ? (
          <div className="admin-row" style={{ marginTop: 0 }}>
            <span className="grow">
              <span className="badge good">
                <Icon name="check" size={12} />
                Configurado
              </span>{" "}
              Convites, redefinições de senha e avisos com e-mail saem pelo SMTP desta instalação.
            </span>
            {canConfigure ? (
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await data.sendTestEmail();
                    notify(`E-mail de teste na fila para ${session.user.email}.`);
                    refresh();
                  } catch (err) {
                    notify(err instanceof Error ? err.message : "Não foi possível.", "error");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Icon name="send" size={14} />
                Mandar teste para mim
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <p>
              <span className="badge neutral">Não configurado</span> Sem e-mail, convites e redefinições mostram o link para você entregar, e os avisos
              ficam só no painel.
            </p>
            <p className="muted small-print">
              Quem instala o Nexo configura o SMTP da própria empresa nas variáveis <span className="mono">SMTP_URL</span> (ex.:{" "}
              <span className="mono">smtp://usuario:senha@smtp.empresa.com:587</span>) e <span className="mono">SMTP_FROM</span>, e reinicia a api e o worker.
            </p>
          </>
        )}
      </section>
      {canConfigure ? (
        <section className="card flush">
          <div className="card-title padded">
            <Icon name="history" size={15} />
            Histórico
            <span className="hint">o conteúdo de convites e redefinições é apagado depois do envio</span>
          </div>
          {history.length ? (
            <table className="list">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Tipo</th>
                  <th>Para</th>
                  <th>Assunto</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="nowrap">{dateTime(h.createdAt)}</td>
                    <td className="nowrap">{KIND_LABEL[h.kind]}</td>
                    <td className="nowrap">{h.recipient}</td>
                    <td>{h.subject}</td>
                    <td>
                      <span className={`badge ${MAIL_STATUS[h.status].badge}`} title={h.lastError ?? undefined}>
                        {MAIL_STATUS[h.status].label}
                      </span>
                      {h.attempts > 1 ? <span className="muted small-print"> {h.attempts} tentativas</span> : null}
                      {h.status === "failed" && h.lastError ? <div className="warning-text small-print">{h.lastError}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted padded">Nenhum e-mail enviado ainda.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
