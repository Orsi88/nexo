import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// Senhas com Argon2id (RNF-026), pelo módulo crypto nativo do Node.js 24 (sem dependência nativa).
// Formato PHC: $argon2id$v=19$m=<KiB>,t=<passes>,p=<paralelismo>$<sal>$<hash>, base64 sem padding.

const argon2Async = promisify(argon2);

export interface Argon2Params {
  memory: number; // KiB
  passes: number;
  parallelism: number;
}

/** Mínimo recomendado pela OWASP para Argon2id (m=19 MiB, t=2, p=1). */
export const DEFAULT_ARGON2: Argon2Params = { memory: 19456, passes: 2, parallelism: 1 };

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

const b64 = (buf: Buffer) => buf.toString("base64").replace(/=+$/, "");

async function derive(password: string, salt: Buffer, params: Argon2Params, tagLength: number): Promise<Buffer> {
  return argon2Async("argon2id", {
    message: Buffer.from(password.normalize("NFKC"), "utf8"),
    nonce: salt,
    parallelism: params.parallelism,
    tagLength,
    memory: params.memory,
    passes: params.passes,
  });
}

export async function hashPassword(password: string, params: Argon2Params = DEFAULT_ARGON2): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, params, 32);
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(encoded);
  if (!match) return false;
  const [, m, t, p, salt, hash] = match;
  const expected = Buffer.from(hash!, "base64");
  const actual = await derive(password, Buffer.from(salt!, "base64"), { memory: +m!, passes: +t!, parallelism: +p! }, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Hash de referência: usado quando o e-mail não existe, para o tempo de resposta não revelar contas. */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

/** Regras mínimas de senha; devolve a mensagem do problema ou undefined. */
export function passwordProblem(password: string): string | undefined {
  if (password.length < PASSWORD_MIN_LENGTH) return `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `A senha pode ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`;
  if (password.trim().length === 0) return "A senha não pode ser só espaços.";
  return undefined;
}
