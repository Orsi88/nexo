import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.tsx";

// Janela de diálogo: fundo escurecido, Esc fecha, foco vai para o primeiro campo e não escapa.

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 560,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not(.modal-close)");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !ref.current) return;
      const focusable = [...ref.current.querySelectorAll<HTMLElement>("input, select, textarea, button, a[href]")].filter((el) => !el.hasAttribute("disabled"));
      if (!focusable.length) return;
      const firstEl = focusable[0]!;
      const lastEl = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);

  // Desenhado direto no <body>: assim o diálogo não herda estilos de onde foi aberto (ex.: de dentro
  // de uma tabela ou seção) e fica sempre por cima de tudo.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref} style={{ width: `min(${width}px, calc(100vw - 32px))` }}>
        <header className="modal-head">
          <div className="grow">
            <h2 id="modal-title">{title}</h2>
            {subtitle ? <div className="sub">{subtitle}</div> : null}
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Fechar">
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
