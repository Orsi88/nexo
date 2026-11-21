import type { ModuleDescriptor } from "../../shared/module.ts";

// API pública do módulo "identity". Outros módulos importam só deste arquivo (ADR-001).

export const identityModule: ModuleDescriptor = {
  name: "identity",
  responsibility: "Login local (Argon2id), sessões, recuperação de acesso e convites",
  owns: ["users", "sessions", "one_time_tokens"],
  requirements: ["RF-131", "RF-132", "RF-133", "RF-140", "RN-048", "RNF-026", "Q-011"],
};

export * as identity from "./repository.ts";
export type { User, UserCredentials, Session, OneTimeToken, OneTimeTokenKind, UserStatus, PendingInvite } from "./repository.ts";
export {
  hashPassword,
  verifyPassword,
  dummyPasswordHash,
  passwordProblem,
  DEFAULT_ARGON2,
  PASSWORD_MIN_LENGTH,
  type Argon2Params,
} from "./passwords.ts";
export { newToken, hashToken, looksLikeToken } from "./tokens.ts";
