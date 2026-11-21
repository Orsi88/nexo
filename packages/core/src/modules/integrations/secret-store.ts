import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Database } from "../../db/database.ts";
import type { SealedSecret, SecretStore } from "../../shared/secret-store.ts";

// Cifragem envelope (§8 da arquitetura, RNF-006, RN-049):
// - cada organização tem uma chave de dados (DEK) aleatória de 256 bits;
// - a DEK fica no banco cifrada pela chave mestra do ambiente (SECRETS_MASTER_KEY);
// - cada segredo é cifrado com a DEK em AES-256-GCM, com a organização como dado associado,
//   então um segredo copiado para outra organização não abre.

const ALGORITHM = "aes-256-gcm";
const DATA_KEY_ID = "dk1";

export interface MasterKeys {
  /** Chave usada para cifrar DEKs novas. */
  currentId: string;
  /** Todas as chaves mestras conhecidas, para abrir DEKs cifradas por chaves anteriores. */
  keys: ReadonlyMap<string, Buffer>;
}

/** Lê SECRETS_MASTER_KEY: 32 bytes em base64. */
export function parseMasterKey(value: string | undefined, id = "m1"): MasterKeys {
  const key = value ? Buffer.from(value, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw new Error("SECRETS_MASTER_KEY precisa ter 32 bytes em base64 (ex.: openssl rand -base64 32)");
  if (key.equals(Buffer.alloc(32))) throw new Error("SECRETS_MASTER_KEY não pode ser só zeros");
  return { currentId: id, keys: new Map([[id, key]]) };
}

function encrypt(key: Buffer, plaintext: Buffer, aad: string): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decrypt(key: Buffer, sealed: { ciphertext: string; iv: string; tag: string }, aad: string): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]);
}

interface WrappedKey {
  ciphertext: string;
  iv: string;
  tag: string;
}

export class EnvelopeSecretStore implements SecretStore {
  readonly #db: Database;
  readonly #master: MasterKeys;
  /** DEKs já abertas, por organização. Só em memória do processo. */
  readonly #cache = new Map<string, Buffer>();

  constructor(db: Database, master: MasterKeys) {
    if (!master.keys.has(master.currentId)) throw new Error("chave mestra atual ausente");
    this.#db = db;
    this.#master = master;
  }

  async seal(organizationId: string, plaintext: string): Promise<SealedSecret> {
    const dek = await this.#dataKey(organizationId, true);
    return { keyId: DATA_KEY_ID, ...encrypt(dek, Buffer.from(plaintext, "utf8"), `secret:${organizationId}`) };
  }

  async open(organizationId: string, sealed: SealedSecret): Promise<string> {
    if (sealed.keyId !== DATA_KEY_ID) throw new Error("chave de dados desconhecida");
    const dek = await this.#dataKey(organizationId, false);
    try {
      return decrypt(dek, sealed, `secret:${organizationId}`).toString("utf8");
    } catch {
      throw new Error("segredo não pôde ser aberto (chave errada ou dado alterado)");
    }
  }

  async #dataKey(organizationId: string, create: boolean): Promise<Buffer> {
    const cached = this.#cache.get(organizationId);
    if (cached) return cached;
    const row = await this.#db.tx({ organizationId }, async (sql) => {
      const select = () =>
        sql.query<{ master_key_id: string; wrapped_key: WrappedKey }>(
          `SELECT master_key_id, wrapped_key FROM integrations_data_keys WHERE organization_id = $1 AND key_id = $2`,
          [organizationId, DATA_KEY_ID],
        );
      let { rows } = await select();
      if (!rows[0] && create) {
        const fresh = randomBytes(32);
        const master = this.#master.keys.get(this.#master.currentId)!;
        const wrapped = encrypt(master, fresh, `dek:${organizationId}:${DATA_KEY_ID}`);
        fresh.fill(0);
        // Duas chamadas simultâneas: a segunda não insere e lê a da primeira.
        await sql.query(
          `INSERT INTO integrations_data_keys (organization_id, key_id, master_key_id, wrapped_key)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [organizationId, DATA_KEY_ID, this.#master.currentId, JSON.stringify(wrapped)],
        );
        ({ rows } = await select());
      }
      return rows[0];
    });
    if (!row) throw new Error("organização sem chave de dados");
    const master = this.#master.keys.get(row.master_key_id);
    if (!master) throw new Error(`chave mestra ${row.master_key_id} não configurada`);
    let dek: Buffer;
    try {
      dek = decrypt(master, row.wrapped_key, `dek:${organizationId}:${DATA_KEY_ID}`);
    } catch {
      throw new Error("chave de dados não pôde ser aberta (SECRETS_MASTER_KEY diferente da usada na criação?)");
    }
    this.#cache.set(organizationId, dek);
    return dek;
  }
}
