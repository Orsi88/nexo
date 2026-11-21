import { useEffect, useState, type DependencyList, type ReactNode } from "react";
import { Icon } from "./icons.tsx";

// Apoio comum das telas.

export type Async<T> = { state: "loading" } | { state: "error"; error: Error } | { state: "ready"; value: T };

export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): Async<T> {
  const [result, setResult] = useState<Async<T>>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    setResult({ state: "loading" });
    fn().then(
      (value) => alive && setResult({ state: "ready", value }),
      (error: unknown) => alive && setResult({ state: "error", error: error instanceof Error ? error : new Error(String(error)) }),
    );
    return () => {
      alive = false;
    };
  }, deps);
  return result;
}

/**
 * Copia texto. A API de área de transferência só existe em HTTPS ou localhost e pode ser negada;
 * nesse caso cai no método antigo (seleção + execCommand), que funciona em http na rede interna.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* tenta o método antigo */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok: boolean;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** Campo com o link e um botão de copiar só com ícone, que confirma ao copiar. */
export function CopyField({ value, label = "Copiar link", onCopied }: { value: string; label?: string; onCopied: (ok: boolean) => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="copy-row">
      <input readOnly className="mono" value={value} onFocus={(e) => e.target.select()} aria-label="Link" />
      <button
        type="button"
        className={`icon-btn${copied ? " copied" : ""}`}
        title={copied ? "Copiado" : label}
        aria-label={copied ? "Copiado" : label}
        onClick={async () => {
          const ok = await copyText(value);
          setCopied(ok);
          onCopied(ok);
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={15} />
      </button>
    </div>
  );
}

/** Linha de configuração: nome e explicação à esquerda, controle compacto à direita. */
export function SettingLine({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-line">
      <div>
        <strong>{title}</strong>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

/** Interruptor liga/desliga (um checkbox por baixo, acessível pelo teclado). */
export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean | undefined; label: string }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

/** Número com unidade ao lado ("90 dias"), estreito. */
export function UnitInput({ value, onChange, min, max, unit, disabled, label }: { value: number; onChange: (v: number) => void; min: number; max: number; unit: string; disabled?: boolean | undefined; label: string }) {
  return (
    <div className="unit-input">
      <input type="number" aria-label={label} min={min} max={max} value={value} disabled={disabled} onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))} />
      <span>{unit}</span>
    </div>
  );
}

export function Loading() {
  return <div className="skeleton" style={{ height: 160 }} aria-busy="true" aria-label="Carregando" />;
}

export function Failure({ error }: { error: Error }) {
  return (
    <div className="notice warning" role="alert">
      {error.message}
    </div>
  );
}

const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

export function ago(iso: string | null): string {
  if (!iso) return "nunca";
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

export function dateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";
}

export function minutes(m: number | null): string {
  if (m === null) return "—";
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}min` : `${m} min`;
}

export const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  manager: "Gestão",
  operator: "Operação",
  reader: "Leitura",
};

export const SOURCE_LABEL: Record<string, string> = {
  discovery: "Descoberta",
  manual: "Edição manual",
  import: "Importação",
  assist: "Assistente",
};

export function branch(ref: string | null): string {
  return ref ? ref.replace(/^refs\/heads\//, "") : "—";
}

/** Esqueleto da página enquanto carrega, no lugar de "Carregando…". */
export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Carregando">
      <div className="skeleton" style={{ height: 34, width: 260, marginBottom: 24 }} />
      <div className="grid stats">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton" style={{ height: 136 }} />
        ))}
      </div>
      <div className="skeleton" style={{ height: 240, marginTop: 12 }} />
    </div>
  );
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /^[\p{L}]/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

// ---------- Paginação (padrão de todas as listas: 15 por página) ----------

export const PAGE_SIZE = 15;

/** Fatia a lista na página atual e devolve a barra de paginação (null quando cabe numa página). */
export function usePaged<T>(items: readonly T[], pageSize = PAGE_SIZE): { shown: T[]; pager: ReactNode } {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages - 1);
  // Volta para a primeira página quando a lista muda de tamanho (ex.: busca).
  useEffect(() => setPage(0), [items.length]);
  return {
    shown: items.slice(current * pageSize, current * pageSize + pageSize),
    pager: <Pager page={current} pages={pages} total={items.length} pageSize={pageSize} onPage={setPage} />,
  };
}

/** Paginação: "1–15 de 47", números das páginas (com reticências) e anterior/próxima. */
export function Pager({ page, pages, total, pageSize, onPage }: { page: number; pages: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, from + pageSize - 1);
  const nums: Array<number | "…"> = [];
  for (let i = 0; i < pages; i++) {
    if (i === 0 || i === pages - 1 || Math.abs(i - page) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  return (
    <nav className="pager" aria-label="Paginação">
      <span className="pager-info num">
        {from}–{to} de {total}
      </span>
      <span className="grow" />
      <button type="button" className="pager-btn" onClick={() => onPage(page - 1)} disabled={page === 0} aria-label="Página anterior">
        <Icon name="chevron" size={14} />
      </button>
      {nums.map((n, i) =>
        n === "…" ? (
          <span key={`gap-${i}`} className="pager-gap">
            …
          </span>
        ) : (
          <button key={n} type="button" className="pager-btn num" aria-current={n === page ? "page" : undefined} onClick={() => onPage(n)}>
            {n + 1}
          </button>
        ),
      )}
      <button type="button" className="pager-btn" onClick={() => onPage(page + 1)} disabled={page === pages - 1} aria-label="Próxima página">
        <Icon name="chevron" size={14} />
      </button>
    </nav>
  );
}


/** Paginação para listas renderizadas dentro de telas com retorno antecipado (onde não cabe hook). */
export function Paged<T>({ items, children }: { items: readonly T[]; children: (shown: T[], pager: ReactNode) => ReactNode }) {
  const { shown, pager } = usePaged(items);
  return <>{children(shown, pager)}</>;
}
