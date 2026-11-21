import { inflateRawSync } from "node:zlib";

// Leitor de .zip mínimo para os artefatos das pipelines (o Azure DevOps e o GitHub entregam
// artefatos como zip). Só lê para a memória — nada é gravado no disco pelo nome que vem dentro
// do zip — e tem limites contra "zip bomb". Suporta "stored" e "deflate"; zip64 e arquivos
// cifrados ficam de fora (o artefato original continua guardado).

export interface ZipEntry {
  name: string;
  size: number;
  /** Lê o conteúdo; lança se passar dos limites ou se o método não for suportado. */
  read(): Buffer;
}

export interface ZipLimits {
  maxEntries: number;
  /** Tamanho máximo de um arquivo descompactado. */
  maxEntryBytes: number;
  /** Soma máxima dos arquivos descompactados que forem lidos. */
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 10_000, maxEntryBytes: 200 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024 };

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function isZip(data: Buffer): boolean {
  return data.length >= 4 && data.readUInt32LE(0) === LOCAL;
}

export function readZip(data: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  // O registro final fica nos últimos 22 bytes + comentário (até 64 KB).
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (data.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("zip sem diretório central");
  const count = data.readUInt16LE(eocd + 10);
  const dirOffset = data.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new ZipError("zip64 não é suportado");
  if (count > limits.maxEntries) throw new ZipError(`zip com arquivos demais (${count})`);

  let used = 0;
  const entries: ZipEntry[] = [];
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > data.length || data.readUInt32LE(p) !== CENTRAL) throw new ZipError("diretório central corrompido");
    const flags = data.readUInt16LE(p + 8);
    const method = data.readUInt16LE(p + 10);
    const compressed = data.readUInt32LE(p + 20);
    const size = data.readUInt32LE(p + 24);
    const nameLen = data.readUInt16LE(p + 28);
    const extraLen = data.readUInt16LE(p + 30);
    const commentLen = data.readUInt16LE(p + 32);
    const localOffset = data.readUInt32LE(p + 42);
    const name = data.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // pasta
    entries.push({
      name,
      size,
      read() {
        if (flags & 0x1) throw new ZipError(`${name}: arquivo cifrado`);
        if (compressed === 0xffffffff || size === 0xffffffff) throw new ZipError(`${name}: zip64 não é suportado`);
        if (size > limits.maxEntryBytes) throw new ZipError(`${name}: grande demais`);
        if (used + size > limits.maxTotalBytes) throw new ZipError("o zip descompactado passa do limite");
        if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== LOCAL) throw new ZipError(`${name}: cabeçalho local corrompido`);
        const start = localOffset + 30 + data.readUInt16LE(localOffset + 26) + data.readUInt16LE(localOffset + 28);
        const raw = data.subarray(start, start + compressed);
        if (raw.length !== compressed) throw new ZipError(`${name}: dados incompletos`);
        let out: Buffer;
        if (method === 0) out = Buffer.from(raw);
        else if (method === 8) {
          try {
            // maxOutputLength corta a descompactação: o tamanho declarado não é confiável.
            out = inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
          } catch {
            throw new ZipError(`${name}: conteúdo corrompido ou maior que o declarado`);
          }
        } else throw new ZipError(`${name}: método de compressão ${method} não suportado`);
        used += out.length;
        return out;
      },
    });
  }
  return entries;
}
