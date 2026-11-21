/**
 * Descrição de um módulo do monólito modular (ADR-001). Um módulo possui suas tabelas e
 * nunca lê as tabelas de outro: a comunicação é pela API pública em modules/<nome>/index.ts.
 */
export interface ModuleDescriptor {
  name: string;
  responsibility: string;
  /** Tabelas que o módulo possui (prefixo do módulo no banco). */
  owns: string[];
  /** Requisitos da especificação v1.1 atendidos pelo módulo. */
  requirements: string[];
}
