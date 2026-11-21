// Ícones de traço fino (24×24, stroke 1.8), desenhados à mão, todos no mesmo estilo.

const paths = {
  home: "M3 10.5 12 3l9 7.5M5 9v11h5v-6h4v6h5V9",
  pipeline: "M6 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4M6 8v8M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4M18 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4M6 12h6a4 4 0 0 0 4-1",
  plug: "M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  users: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 19v-1a4 4 0 0 0-3-3.87M16 3.13a3.5 3.5 0 0 1 0 6.75",
  audit: "M9 3h6l1 2h3v16H5V5h3zM9 12h6M9 16h4",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8",
  sidebar: "M4 4h16v16H4zM9 4v16",
  panel: "M4 4h16v16H4zM15 4v16",
  close: "M6 6l12 12M18 6 6 18",
  check: "M4 12.5 9 17.5 20 6.5",
  x: "M6 6l12 12M18 6 6 18",
  ban: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M5.6 5.6l12.8 12.8",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2",
  play: "M7 4v16l13-8z",
  refresh: "M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4",
  branch: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 9a9 9 0 0 1-9 9",
  chevron: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  back: "M19 12H5M11 18l-6-6 6-6",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1",
  bell: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0",
  plus: "M12 5v14M5 12h14",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  alert: "M12 3 2 20h20zM12 10v4M12 17.5v.5",
  key: "M7.5 20a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9M10.7 12.3 20 3M16 7l3 3M13.5 9.5l2 2",
  file: "M6 3h9l4 4v14H6zM14 3v5h5",
  history: "M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  table: "M3 5h18v14H3zM3 10h18M3 15h18M9 5v14",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M21 21l-4.3-4.3",
  sparkles: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2",
  layers: "M12 3 2 8l10 5 10-5zM2 16l10 5 10-5M2 12l10 5 10-5",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  archive: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
  unarchive: "M3 4h18v4H3zM5 8v12h14V8M12 18v-6M9.5 14.5 12 12l2.5 2.5",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  power: "M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0",
  share: "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6M8.6 13.5l6.8 4M15.4 6.5l-6.8 4",
  mail: "M3 5h18v14H3zM3 6l9 7 9-7",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  bot: "M12 3v3M5 8h14v11H5zM9 13h.01M15 13h.01M9 17h6M2 12v3M22 12v3",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
} as const;

export type IconName = keyof typeof paths;

/**
 * Ação de linha só com ícone (editar = lápis, apagar = lixeira...). O nome da ação vai na dica
 * (title) e no aria-label: o ícone nunca fica sem nome para leitor de tela.
 */
export function IconButton({
  icon,
  label,
  onClick,
  disabled,
  danger,
  type = "button",
}: {
  icon: IconName;
  label: string;
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
  danger?: boolean | undefined;
  type?: "button" | "submit";
}) {
  return (
    <button type={type} className={`icon-btn${danger ? " danger" : ""}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={15} />
    </button>
  );
}

export function Icon({ name, size = 18, title }: { name: IconName; size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={paths[name]} />
    </svg>
  );
}
