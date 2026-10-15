/**
 * Papéis do CRM — espelha apps/api/src/services/userScope.ts (a API é que
 * decide; isto só esconde o que daria 403).
 */
type Role = string | null | undefined;

/** Configuração técnica: telefonia, canais, API/webhooks, definições da conta. */
export const isConfigAdmin = (role: Role) => role === 'OWNER' || role === 'ADMIN';
/** Gestão da operação: equipa, supervisão, tipificações. */
export const isOpsManager = (role: Role) => isConfigAdmin(role) || role === 'MANAGER';
/** Vê a conta inteira (o resto vê a sua equipa ou só o que é seu). */
export const seesWholeTenant = (role: Role) => isOpsManager(role) || role === 'VIEWER';
