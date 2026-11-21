import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Onde a plataforma guarda os artefatos originais das execuções (R-007: o original é sempre
 * preservado). ADR-005 prevê object storage S3; esta interface permite trocar a implementação
 * sem mudar quem guarda e lê.
 */
export interface ArtifactStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | undefined>;
  delete(key: string): Promise<void>;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,500}$/;

function checkKey(key: string): void {
  if (!KEY.test(key) || key.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("chave de artefato inválida");
  }
}

/**
 * Guarda em pasta local (instalação de uma máquina só, ou um volume do Docker). As chaves são
 * montadas pela plataforma a partir de ids, nunca de nomes vindos do provedor.
 */
export class FileArtifactStore implements ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #path(key: string): string {
    checkKey(key);
    const path = resolve(join(this.#root, key));
    if (!path.startsWith(this.#root + sep)) throw new Error("chave de artefato fora da pasta");
    return path;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.#path(key));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }
}

/** Guarda em memória: testes e demonstração. */
export class MemoryArtifactStore implements ArtifactStore {
  readonly files = new Map<string, Buffer>();
  async put(key: string, data: Buffer): Promise<void> {
    checkKey(key);
    this.files.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Buffer | undefined> {
    return this.files.get(key);
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
}
