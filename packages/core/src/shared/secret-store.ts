/**
 * Armazenamento de segredos (RNF-006, RN-017, RN-049). Implementação inicial proposta:
 * cifragem envelope AES-256-GCM, com chave de dados por organização protegida por uma chave
 * mestra vinda do ambiente ou de um KMS. Pode ser trocada por um cofre (Vault) sem mudar quem usa.
 */
export interface SecretStore {
  seal(organizationId: string, plaintext: string): Promise<SealedSecret>;
  open(organizationId: string, sealed: SealedSecret): Promise<string>;
}

/** Forma persistida. Nunca contém o texto claro e nunca vai para log, export ou link. */
export interface SealedSecret {
  keyId: string;
  ciphertext: string;
  iv: string;
  tag: string;
}
