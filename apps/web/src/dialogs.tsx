import { useEffect, useState } from "react";
import { Icon, type IconName } from "./icons.tsx";
import { Modal } from "./modal.tsx";

// Confirmações e perguntas no estilo do Nexo, no lugar de window.confirm/prompt (que fogem do visual
// do painel e não podem ser estilizadas). Uso: `if (!(await confirmDialog({...}))) return;`.
// O <DialogHost /> fica uma vez na raiz do App e desenha o diálogo pendente.

interface ConfirmOptions {
  title: string;
  message?: React.ReactNode;
  confirmLabel: string;
  /** Ação que destrói ou tira acesso: botão vermelho. */
  danger?: boolean;
  icon?: IconName;
}

interface PromptOptions {
  title: string;
  message?: React.ReactNode;
  label: string;
  placeholder?: string;
  confirmLabel: string;
  /** Campo opcional: confirmar vazio devolve "". */
  optional?: boolean;
  multiline?: boolean;
}

type Pending =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void };

let current: Pending | null = null;
const listeners = new Set<(p: Pending | null) => void>();
const emit = () => listeners.forEach((l) => l(current));

function open(p: Pending) {
  // Um diálogo por vez: o anterior, se houver, é dado como cancelado.
  if (current?.kind === "confirm") current.resolve(false);
  else if (current?.kind === "prompt") current.resolve(null);
  current = p;
  emit();
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => open({ kind: "confirm", options, resolve }));
}

export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => open({ kind: "prompt", options, resolve }));
}

function close() {
  current = null;
  emit();
}

export function DialogHost() {
  const [pending, setPending] = useState<Pending | null>(current);
  const [value, setValue] = useState("");
  useEffect(() => {
    listeners.add(setPending);
    return () => {
      listeners.delete(setPending);
    };
  }, []);
  useEffect(() => setValue(""), [pending]);
  if (!pending) return null;

  if (pending.kind === "confirm") {
    const o = pending.options;
    const finish = (ok: boolean) => {
      pending.resolve(ok);
      close();
    };
    return (
      <Modal
        title={o.title}
        onClose={() => finish(false)}
        width={460}
        footer={
          <button type="button" className={`btn ${o.danger ? "danger-solid" : "primary"}`} onClick={() => finish(true)}>
            {o.confirmLabel}
          </button>
        }
      >
        <div className="dialog-body">
          <span className={`dialog-icon${o.danger ? " danger" : ""}`} aria-hidden="true">
            <Icon name={o.icon ?? (o.danger ? "alert" : "check")} size={18} />
          </span>
          <div>{o.message}</div>
        </div>
      </Modal>
    );
  }

  const o = pending.options;
  const finish = (v: string | null) => {
    pending.resolve(v);
    close();
  };
  return (
    <Modal
      title={o.title}
      onClose={() => finish(null)}
      width={480}
      footer={
        <button type="submit" form="dialog-prompt" className="btn primary" disabled={!o.optional && !value.trim()}>
          {o.confirmLabel}
        </button>
      }
    >
      <form
        id="dialog-prompt"
        className="execute-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (o.optional || value.trim()) finish(value.trim());
        }}
      >
        {o.message ? <div className="dialog-message">{o.message}</div> : null}
        <div className="field">
          <label htmlFor="dialog-value">{o.label}</label>
          {o.multiline ? (
            <textarea id="dialog-value" rows={3} value={value} placeholder={o.placeholder} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <input id="dialog-value" value={value} placeholder={o.placeholder} onChange={(e) => setValue(e.target.value)} />
          )}
        </div>
      </form>
    </Modal>
  );
}
