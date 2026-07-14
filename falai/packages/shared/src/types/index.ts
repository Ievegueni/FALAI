export type AdminRole = "SUPERADMIN" | "OPERATOR" | "FINANCE" | "SUPPORT";
export type TenantRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
export type AgentStatus = "DRAFT" | "PENDING_REVIEW" | "ACTIVE" | "PAUSED" | "BLOCKED";
export type CallStatus =
  | "QUEUED" | "DIALING" | "RINGING" | "IN_PROGRESS"
  | "COMPLETED" | "NO_ANSWER" | "BUSY" | "FAILED" | "CANCELLED" | "ESCALATED";
export type CampaignStatus = "DRAFT" | "SCHEDULED" | "RUNNING" | "PAUSED" | "DONE" | "CANCELLED";
export type TxType = "TOPUP" | "CALL_CHARGE" | "REFUND" | "ADJUSTMENT" | "MONTHLY_FEE";
export type TurnRole = "AGENT" | "HUMAN" | "SYSTEM";
export type AuditActorType = "ADMIN" | "TENANT_USER" | "API_KEY" | "SYSTEM";

// LLM structured response from call engine
export interface LlmTurnResponse {
  reply: string;
  action:
    | { type: "continue" }
    | { type: "end_call" }
    | { type: "escalate"; to?: string }
    | { type: "capture"; data: Record<string, unknown> };
}

// Formatação monetária AOA (centavos → string)
export function formatKz(cents: number): string {
  const value = cents / 100;
  return value.toLocaleString("pt-AO", {
    style: "currency",
    currency: "AOA",
    minimumFractionDigits: 2,
  });
}
