// ─── Admin ────────────────────────────────────────────────────────────────────

export type AdminRole = 'SUPERADMIN' | 'OPERATOR' | 'FINANCE' | 'SUPPORT';
export type TenantStatus = 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
export type AgentStatus = 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' | 'PAUSED' | 'BLOCKED';
export type AgentReviewStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'BLOCKED';
export type CallStatus =
  | 'QUEUED' | 'DIALING' | 'RINGING' | 'IN_PROGRESS'
  | 'COMPLETED' | 'NO_ANSWER' | 'FAILED' | 'CANCELLED' | 'ESCALATED';
export type TransactionType = 'TOPUP' | 'CALL_CHARGE' | 'SMS_CHARGE' | 'REFUND' | 'ADJUSTMENT' | 'MONTHLY_FEE';

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  twoFaEnabled: boolean;
}

export interface AdminLoginResponse {
  token: string;
  requiresTwoFactor: boolean;
  user: AdminUser;
}

// ─── Tenant ───────────────────────────────────────────────────────────────────

export type ProductType = 'VOICE_AI' | 'CRM_BYO_PBX';

export type BillingMode = 'PER_MINUTE' | 'PER_SECOND' | 'PER_CALL';

export interface Plan {
  id: string;
  name: string;
  productType: ProductType;
  aiAgentsEnabled: boolean;
  clinicEnabled: boolean;
  smsEnabled: boolean;
  billingMode: BillingMode;
  pricePerMinCents: number;
  pricePerCallCents: number;
  pricePerSmsCents: number;
  monthlyFeeCents: number;
  maxAgents: number;
  maxConcurrentCalls: number;
  isActive: boolean;
}

export type FeatureKey =
  | 'agents'
  | 'campaigns'
  | 'contacts'
  | 'calls'
  | 'directCall'
  | 'otpCall'
  | 'wallet'
  | 'team'
  | 'developers';

export type TenantFeatures = Record<FeatureKey, boolean>;

export interface TenantLine {
  id: string;
  tenantId: string;
  name: string;
  extension: string;
  phoneNumber: string | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TenantLineInput {
  name: string;
  extension: string;
  phoneNumber?: string;
  isDefault?: boolean;
  isActive?: boolean;
}

export type TenantRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface TenantUser {
  id: string;
  name: string;
  email: string;
  role: TenantRole;
  lastLoginAt: string | null;
  twoFaEnabled?: boolean;
  createdAt?: string;
}

export interface TenantUserInput {
  name: string;
  email: string;
  password: string;
  role?: TenantRole;
}

export interface Tenant {
  id: string;
  name: string;
  email: string;
  phone: string;
  nif: string | null;
  status: TenantStatus;
  balanceCents: number;
  creditLimitCents: number;
  webhookUrl: string | null;
  onboardingCompletedAt: string | null;
  planId: string;
  plan: Plan;
  maxConcurrentCalls: number;
  features?: TenantFeatures;
  featureOverrides?: Partial<TenantFeatures>;
  billingModeOverride?: BillingMode | null;
  lines?: TenantLine[];
  users?: TenantUser[];
  createdAt: string;
  _count?: {
    calls: number;
    agents: number;
    contacts: number;
  };
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  objective: string;
  systemPrompt: string;
  status: AgentStatus;
  reviewStatus: AgentReviewStatus;
  language: string;
  maxCallSeconds: number;
  reviewRejectionReason: string | null;
  submittedAt: string;
  createdAt: string;
  updatedAt: string;
  tenant: { name: string; id: string };
}

// ─── Call ────────────────────────────────────────────────────────────────────

export interface Call {
  id: string;
  tenantId: string;
  agentId: string;
  to: string;
  status: CallStatus;
  outcome: string | null;
  durationSecs: number | undefined;
  costCents: number | undefined;
  providerCostCents: number | undefined;
  failReason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  tenant: { name: string };
  agent: { name: string };
  turns?: CallTurn[];
}

export interface CallTurn {
  id: string;
  seq: number;
  role: 'assistant' | 'user';
  text: string;
  sttMs: number | null;
  llmMs: number | null;
  ttsMs: number | null;
  playMs: number | null;
  createdAt: string;
}

// ─── Finance ─────────────────────────────────────────────────────────────────

export interface FinanceSummary {
  revenueCents: number;
  subscriptionRevenueCents: number;
  callRevenueCents: number;
  providerCostCents: number;
  marginCents: number;
  marginPct: number;
  totalCalls: number;
  totalMinutes: number;
  chartData: FinanceChartPoint[];
}

export interface FinanceChartPoint {
  date: string;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  calls: number;
}

export interface MarginRow {
  tenantId: string;
  tenantName: string;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginPct: number;
  calls: number;
}

export interface WalletTransaction {
  id: string;
  tenantId: string;
  type: TransactionType;
  amountCents: number;
  balanceAfterCents: number;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  tenant: { name: string };
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export interface AdminDashboardMetrics {
  tenantsActive: number;
  tenantsTotal: number;
  callsToday: number;
  minutesToday: number;
  revenueToday: number;
  marginToday: number;
  agentsPendingReview: number;
  concurrentNow: number;
  concurrentCapacity: number;
  liveCalls: LiveCall[];
  chartData: { date: string; calls: number; revenue: number }[];
}

export interface LiveCall {
  id: string;
  tenantName: string;
  agentName: string;
  to: string;
  status: CallStatus;
  durationSecs: number;
  startedAt: string;
}

// ─── System ──────────────────────────────────────────────────────────────────

export interface SystemSetting {
  key: string;
  value: string;
  isSecret: boolean;
  updatedBy: string | null;
  updatedAt: string;
}

export interface SystemEvent {
  id: string;
  severity: 'info' | 'warning' | 'error';
  source: string;
  message: string;
  payload: unknown;
  createdAt: string;
}

export interface ProviderHealth {
  name: string;
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  latencyMs: number | null;
  detail: string | null;
}

export interface HealthStatus {
  providers: ProviderHealth[];
  concurrentCalls: number;
  concurrentCapacity: number;
  recentEvents: SystemEvent[];
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export interface AuditLog {
  id: string;
  actorType: 'ADMIN' | 'TENANT_USER' | 'API_KEY' | 'SYSTEM';
  actorId: string;
  tenantId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
}

// ─── Pagination ──────────────────────────────────────────────────────────────

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  perPage: number;
}
