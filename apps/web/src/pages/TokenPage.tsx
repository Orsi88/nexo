import { useState } from "react";
import { ApiError } from "../data/errors.ts";
import { Icon } from "../icons.tsx";

// Páginas abertas por link de uso único (ADR-011): /redefinir-senha#token=… e /convite#token=….
// O token vem no fragmento (#), que o navegador não envia ao servidor nem no Referer. Assim que a
// página abre, o endereço é limpo, para o token não ficar no histórico.

export type TokenKind = "reset" | "invite";

const MIN_PASSWORD = 12;

/** Lê o tipo e o token do endereço; undefined se não for uma dessas páginas. */
export function tokenFromLocation(): { kind: TokenKind; token: string } | undefined {
  const kind = location.pathname === "/redefinir-senha" ? "reset" : location.pathname === "/convite" ? "invite" : undefined;
  if (!kind) return undefined;
  const token = new URLSearchParams(location.hash.replace(/^#/, "")).get("token") ?? "";
  history.replaceState(null, "", "/");
  return /^[A-Za-z0-9_-]{20,100}$/.test(token) ? { kind, token } : { kind, token: "" };
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = res.headers.get("content-type")?.includes("application/json") ? await res.json() : null;
  if (!res.ok) {
    const { error, message } = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, error ?? "internal", message ?? `Erro ${res.status}`);
  }
  return data;
}

export function TokenPage({ kind, token, onDone }: { kind: TokenKind; token: string; onDone: (message: string) => void }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(token ? null : "Link incompleto ou inválido. Peça um novo a quem administra o Nexo.");
  const [busy, setBusy] = useState(false);
  const invite = kind === "invite";

  const problem =
    password && password.length < MIN_PASSWORD
      ? `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`
      : confirm && confirm !== password
        ? "As duas senhas não são iguais."
        : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problem || !token) return;
    setBusy(true);
    setError(null);
    try {
      if (invite) {
        await post("/api/auth/invites/accept", { token, password, ...(name.trim() ? { displayName: name.trim() } : {}) });
        onDone("Convite aceito. Entre com o seu e-mail e a senha que você acabou de definir.");
      } else {
        await post("/api/auth/password-reset/complete", { token, password });
        onDone("Senha definida. Entre com o seu e-mail e a senha nova.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível concluir.");
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card entry-card" onSubmit={submit}>
        <div className="entry-brand">
          <img className="login-logo" src="/logo.png" alt="" />
          <span className="entry-name">Nexo</span>
        </div>
        <h1 className="entry-title">{invite ? "Aceitar convite" : "Definir senha"}</h1>
        <p className="entry-hint">
          {invite ? "Escolha como você vai aparecer e a sua senha." : "Escolha a senha que você vai usar para entrar."} Este link vale uma vez.
        </p>
        {invite ? (
          <label className="field">
            <span>Seu nome (opcional)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
        ) : null}
        <label className="field">
          <span>Senha</span>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={MIN_PASSWORD}
            autoFocus
          />
        </label>
        <label className="field">
          <span>Repita a senha</span>
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        <p className="muted small-print" style={{ marginBottom: 12 }}>
          <Icon name="key" size={12} /> Pelo menos {MIN_PASSWORD} caracteres. Uma frase com espaços também vale.
        </p>
        {problem || error ? (
          <div className="notice warning" role="alert">
            {problem ?? error}
          </div>
        ) : null}
        <button className="btn primary entry-submit" type="submit" disabled={busy || !token || Boolean(problem) || !password || !confirm}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {invite ? "Aceitar e definir senha" : "Definir senha"}
        </button>
      </form>
    </div>
  );
}
