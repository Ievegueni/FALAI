// ─── Auth / Tenant ───────────────────────────────────────────────────────────

export type TenantRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
export type TenantStatus = 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export interface TenantUser {
  id: string;
  email: string;
  name: string;
  role: TenantRole;
  twoFaEnabled: boolean;
  createdAt: string;
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

export interface Tenant {
  id: string;
  name: string;
  status: TenantStatus;
  balanceCents: number;
  creditLimitCents: number;
  webhookUrl: string | null;
  planId: string;
  plan: Plan;
  features?: TenantFeatures;
  onboardingCompletedAt: string | null;
}

export interface LoginResponse {
  token: string;
  requiresTwoFactor: boolean;
  user: TenantUser;
  tenant: Tenant;
}

export interface MeResponse {
  user: TenantUser;
  tenant: Tenant;
}

// ─── Plan ────────────────────────────────────────────────────────────────────

export type ProductType = 'VOICE_AI' | 'CRM_BYO_PBX';

export interface Plan {
  id: string;
  name: string;
  productType?: ProductType;
  aiAgentsEnabled?: boolean;
  clinicEnabled?: boolean;
  smsEnabled?: boolean;
  pricePerMinuteCents: number;
  pricePerCallCents: number;
  monthlyFeeCents: number;
  maxAgents: number;
  maxConcurrent: number;
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export type AgentStatus = 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' | 'PAUSED' | 'BLOCKED';

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  systemPrompt: string;
  variablesSchema: Record<string, VariableField>;
  voiceId: string | null;
  maxDurationSecs: number;
  escalationPhone: string | null;
  reviewRejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  currentVersion: number;
}

export interface VariableField {
  label: string;
  required: boolean;
  example?: string;
}

export interface AgentVersion {
  id: string;
  version: number;
  systemPrompt: string;
  createdAt: string;
}

export interface AgentEditorFields {
  name: string;
  objective: string;
  tone: string;
  dataToCollect: string;
  neverSay: string;
  maxDurationSecs: number;
  escalationPhone?: string;
}

export interface SimulateRequest {
  message: string;
  history: SimMessage[];
  variables?: Record<string, string>;
}

export interface SimMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SimulateResponse {
  reply: string;
  action: 'continue' | 'end' | 'escalate';
}

// ─── Contact ─────────────────────────────────────────────────────────────────

export interface Contact {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  attributes: Record<string, string>;
  optedOutAt: string | null;
  optOutReason: string | null;
  createdAt: string;
  // Presente apenas na resposta de detalhe (GET /tenant/contacts/:id)
  calls?: ContactCall[];
}

export interface ContactCall {
  id: string;
  toNumber: string;
  kind: CallKind;
  status: CallStatus;
  outcome: string | null;
  durationSecs: number;
  createdAt: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: { row: number; phone: string; reason: string }[];
  jobId?: string;
}

// ─── Call ────────────────────────────────────────────────────────────────────

export type CallStatus =
  | 'QUEUED'
  | 'DIALING'
  | 'RINGING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'NO_ANSWER'
  | 'FAILED'
  | 'CANCELLED'
  | 'ESCALATED';

export type SmsStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED';

export interface SmsMessage {
  id: string;
  toNumber: string;
  body: string;
  segments: number;
  status: SmsStatus;
  costCents: number;
  senderId: string | null;
  campaignId: string | null;
  failReason: string | null;
  createdAt: string;
  contact: { name: string | null } | null;
}

export interface SmsCampaign {
  id: string;
  name: string;
  body: string;
  status: CampaignStatus;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  costCents: number;
  throttlePerMinute?: number;
  createdAt: string;
  startedAt?: string | null;
  completedAt: string | null;
}

export interface SmsConfig {
  enabled: boolean;
  configured: boolean;
  senderId: string | null;
  pricePerSegmentCents: number;
}

export type CallKind = 'AI_AGENT' | 'DIRECT' | 'OTP' | 'INBOUND';

export type CallDirection = 'inbound' | 'outbound' | 'internal';

export interface Call {
  id: string;
  agentId: string | null;
  kind?: CallKind;
  direction?: CallDirection;
  contactId: string | null;
  to: string;
  from?: string | null;
  /** Número do interveniente externo (entrada → origem; saída → destino). */
  party?: string;
  status: CallStatus;
  outcome: string | null;
  durationSecs: number | null;
  costCents: number | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  agent: { name: string };
  contact: { name: string } | null;
  recordingUrl: string | null;
  turns?: CallTurn[];
  variables?: Record<string, string>;
}

export interface CallTurn {
  id: string;
  seq: number;
  role: 'agent' | 'user';
  text: string;
  sttMs: number | null;
  llmMs: number | null;
  ttsMs: number | null;
  createdAt: string;
}

// ─── Campaign ────────────────────────────────────────────────────────────────

export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
export type CampaignMode = 'VOICE_AI' | 'FIXED_SCRIPT';

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  mode: CampaignMode;
  agentId: string | null;
  agent: { name: string } | null;
  scriptText: string | null;
  ttsVoiceId: string | null;
  totalContacts: number;
  pendingCount: number;
  completedCount: number;
  failedCount: number;
  answeredCount: number;
  estimatedCostCents: number | null;
  actualCostCents: number;
  scheduleJson: CampaignSchedule;
  retryPolicy: RetryPolicy;
  throttlePerMinute: number;
  summary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CampaignSchedule {
  startHour: number;
  endHour: number;
  timezone: string;
  daysOfWeek: number[];
}

export interface RetryPolicy {
  maxAttempts: number;
  delayMinutes: number;
  retryOn: CallStatus[];
}

// ─── Wallet ──────────────────────────────────────────────────────────────────

export type TransactionType = 'TOPUP' | 'CALL_CHARGE' | 'SMS_CHARGE' | 'REFUND' | 'ADJUSTMENT' | 'MONTHLY_FEE';

export interface WalletTransaction {
  id: string;
  type: TransactionType;
  amountCents: number;
  balanceAfterCents: number;
  note: string | null;
  callId: string | null;
  proxypayRef: string | null;
  createdAt: string;
}

export interface TopupResponse {
  reference: string;
  amountCents: number;
  entity: string;
  expiresAt: string;
}

// ─── API Key ─────────────────────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
  rawKey?: string;
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export interface DashboardMetrics {
  balanceCents: number;
  callsToday: number;
  callsThisMonth: number;
  answerRatePct: number;
  avgDurationSecs: number;
  avgCostCents: number;
  activeAgents: number;
  activeCampaigns: number;
  recentCalls: Call[];
  chartData: DashboardChartPoint[];
}

export interface DashboardChartPoint {
  date: string;
  total: number;
  answered: number;
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface TenantSettings {
  name: string;
  webhookUrl: string | null;
  webhookSecret: string | null;
  fiscalName: string | null;
  fiscalNif: string | null;
  fiscalAddress: string | null;
  lowBalanceAlertCents: number | null;
  lowBalanceAlertEmail: string | null;
  lowBalanceAlertPhone: string | null;
}

// ─── Telefonia (módulo PBX nativo) ───────────────────────────────────────────

export interface Extension {
  id: string;
  number: string;
  callerId: string;
  displayName: string | null;
  email: string | null;
  mobile: string | null;
  roleId: string | null;
  sipAuthUser: string;
  sipSecretSet: boolean;
  maxIpRegs: number;
  maxWebRegs: number;
  presence: Record<string, unknown> | null;
  voicemail: Record<string, unknown> | null;
  features: Record<string, unknown> | null;
  voip: Record<string, unknown> | null;
  security: Record<string, unknown> | null;
  isActive: boolean;
  isDefault: boolean;
  phoneNumber: string | null;
  createdAt: string;
  updatedAt: string;
  /** Só presente na resposta de criar / reset-sip — mostrar uma única vez. */
  sipAuthSecret?: string;
}

export interface ExtensionGroupMemberRef {
  id: string;
  number: string;
  callerId: string;
}

export interface ExtensionGroup {
  id: string;
  name: string;
  isDefault: boolean;
  permissions: Record<string, unknown> | null;
  members: ExtensionGroupMemberRef[];
  total: number;
}

export interface TelephonyRole {
  id: string;
  name: string;
  permissions: Record<string, unknown>;
  _count?: { extensions: number };
}

export interface TrunkView {
  id: string;
  tenantId: string | null;
  shared: boolean;
  editable: boolean;
  name: string;
  enabled: boolean;
  type: 'REGISTER' | 'PEER';
  transport: 'UDP' | 'TCP' | 'TLS';
  host: string;
  port: number;
  domain: string | null;
  authUser: string;
  authName: string | null;
  secretSet: boolean;
  codecs: string[];
  dtmfMode: string;
  maxConcurrent: number | null;
  dids: { id: string; did: string; name: string | null }[];
}

// ─── Pagination ──────────────────────────────────────────────────────────────

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  perPage: number;
}
