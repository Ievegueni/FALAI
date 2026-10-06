// ─── Auth / Tenant ───────────────────────────────────────────────────────────

export type TenantRole = 'OWNER' | 'ADMIN' | 'MANAGER' | 'SUPERVISOR' | 'MEMBER' | 'VIEWER';
export type TenantStatus = 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export interface TenantUser {
  id: string;
  email: string;
  name: string;
  role: TenantRole;
  twoFaEnabled: boolean;
  createdAt: string;
  /** Perfil definido pela Comunica no backoffice; null = sem restrição. Os módulos "none" já vêm desligados em tenant.features. */
  accessProfile?: { id: string; name: string; permissions: Partial<Record<FeatureKey | 'dashboard', 'none' | 'read' | 'write'>> } | null;
  /** Extensão do utilizador e grupos que supervisiona (melhoria 4) — vêm da lista da Equipa. */
  extensionId?: string | null;
  /** Grupos onde a extensão do utilizador atende. */
  groupIds?: string[];
  supervisedGroupIds?: string[];
}

export type FeatureKey =
  | 'agents'
  | 'campaigns'
  | 'contacts'
  | 'calls'
  | 'directCall'
  | 'otpCall'
  | 'webphone'
  | 'wallet'
  | 'team'
  | 'developers'
  | 'reports'
  | 'sms'
  | 'telephony'
  | 'inbox'
  | 'tickets';

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
  /** Logo definido pela Comunica no backoffice (data URL). Null = logo da Comunica. */
  logoDataUrl?: string | null;
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
  phone: string | null;
  telegramId?: string | null;
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
  | 'BUSY'
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
  /** Motivo técnico da falha (ex.: número inválido, sem saldo). Só em chamadas FAILED. */
  failReason?: string | null;
  durationSecs: number | null;
  costCents: number | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  agent: { name: string };
  contact: { name: string } | null;
  /** Só no detalhe: ticket a que a chamada pertence. */
  ticket?: TicketRef | null;
  /** Chamadas de entrada: a extensão que atendeu e a tipificação (melhorias 1–2). */
  handledBy?: { number: string; name: string | null } | null;
  typing?: string | null;
  /** Só no detalhe de uma chamada de entrada: percurso, tipificação e notas. */
  attendance?: {
    group: string | null;
    waitSecs: number | null;
    legs: {
      id: string;
      extension: string;
      agent: string | null;
      outcome: 'ANSWERED' | 'NO_ANSWER' | 'REJECTED' | 'BUSY' | 'CANCELLED' | 'FAILED' | null;
      ringStartedAt: string;
      responseSecs: number | null;
      reason: string | null;
    }[];
    typing: {
      legId: string;
      category: string | null;
      subcategory: string | null;
      note: string | null;
      typedAt: string | null;
      typedBy: string | null;
      pendingUntil: string | null;
    } | null;
    notes: { id: string; body: string; createdAt: string; author: string | null }[];
  };
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
  /** Nunca tentados: campanha cancelada ou contacto removido. */
  skippedCount: number;
  optedOutCount: number;
  /** Base de cálculo da taxa de atendimento: só quem foi realmente contactado. */
  attemptedCount: number;
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

export type CampaignContactStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED'
  | 'OPTED_OUT'
  | 'SKIPPED';

/** Um participante da campanha com o desfecho da respectiva chamada. */
export interface CampaignContactRow {
  id: string;
  contactId: string;
  name: string | null;
  phone: string;
  status: CampaignContactStatus;
  attempts: number;
  nextRetryAt: string | null;
  optedOutAt: string | null;
  optOutReason: string | null;
  updatedAt: string;
  callId: string | null;
  callStatus: CallStatus | null;
  outcome: string | null;
  failReason: string | null;
  durationSecs: number | null;
  costCents: number | null;
  recordingUrl: string | null;
  answeredAt: string | null;
  endedAt: string | null;
}

export interface CampaignSchedule {
  /** "NOW" liga assim que a campanha for lançada, ignorando hora e dias. */
  mode?: 'NOW' | 'WINDOW';
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

export type TransactionType = 'TOPUP' | 'CALL_CHARGE' | 'SMS_CHARGE' | 'TEXT_CHARGE' | 'REFUND' | 'ADJUSTMENT' | 'MONTHLY_FEE';

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
  /** Origens permitidas (IP ou CIDR). Vazio = a chave aceita qualquer origem. */
  allowedCidrs: string[];
  lastUsedAt: string | null;
  createdAt: string;
  rawKey?: string;
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export interface DashboardMetrics {
  balanceCents: number;
  callsToday: number;
  inboundToday: number;
  outboundToday: number;
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

/** Credenciais prontas a usar no JsSIP do webphone (endpoint WebRTC, não o hardphone). */
export interface WebphoneCredentials {
  /** Utilizador do URI/From SIP — nome do endpoint web (extweb_...). */
  sipUser: string;
  /** Utilizador do Digest — sipAuthUser cru, sem prefixo. */
  sipAuthUser: string;
  sipAuthSecret: string;
  wsUri: string;
  sipDomain: string;
  displayName: string | null;
  number: string;
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

export type IvrDestType = 'EXTENSION' | 'GROUP' | 'IVR';

export interface IvrOption {
  digit: string;
  destType: IvrDestType;
  destValue: string;
}

export interface IvrMenu {
  id: string;
  name: string;
  greeting: string;
  greetingAudio?: boolean; // saudação é um ficheiro carregado (não TTS)
  welcomeAudio?: boolean; // boas-vindas carregadas, tocadas uma vez antes da saudação
  options: IvrOption[];
  timeoutSecs: number;
  maxRetries: number;
}

export interface InboundRoute {
  id: string;
  name: string;
  trunkId: string;
  trunkName: string;
  didPattern: string;
  destType: IvrDestType | 'AI_AGENT';
  destValue: string;
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

// ─── Canais de texto (caixa de entrada) ──────────────────────────────────────

export type Channel = 'WEBCHAT' | 'EMAIL' | 'TELEGRAM' | 'WHATSAPP';
export type ConversationStatus = 'OPEN' | 'PENDING' | 'RESOLVED';
export type ConversationMode = 'AI' | 'HUMAN';

export interface Inbox {
  id: string;
  channel: Channel;
  name: string;
  agentId: string | null;
  autoReply: boolean;
  enabled: boolean;
  config: Record<string, unknown>;
  secretsSet: Record<string, boolean>;
  snippet?: string;
  /** WhatsApp: a colar na app da Meta */
  webhookUrl?: string;
  verifyToken?: string;
  poolUrl?: string;
  /** WhatsApp: estado no pool Active/Standby do botão do site */
  pool?: {
    status: WaPoolStatus | null;
    priority: number | null;
    failCount: number;
    lastCheckAt: string | null;
    lastError: string | null;
    statusAt: string | null;
  };
  createdAt: string;
}

export type WaPoolStatus = 'ACTIVE' | 'DEGRADED' | 'STANDBY' | 'FAILED' | 'DISABLED';

export interface ConversationMessage {
  id: string;
  seq: number;
  /** HUMAN = cliente; AGENT = IA (authorId nulo) ou operador; SYSTEM = nota interna */
  role: 'HUMAN' | 'AGENT' | 'SYSTEM';
  text: string;
  authorId: string | null;
  attachments: { file: string; name: string; size: number }[] | null;
  guardrailFlags: string[] | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  status: ConversationStatus;
  mode: ConversationMode;
  subject: string | null;
  assigneeId: string | null;
  lastMessageAt: string;
  updatedAt: string;
  inbox: { id: string; name: string; channel: Channel };
  contact: { id: string; name: string | null; phone: string | null; email: string | null; telegramId: string | null } | null;
  assignee: { id: string; name: string } | null;
  ticket?: TicketRef | null;
  lastMessage?: { role: ConversationMessage['role']; text: string; createdAt: string } | null;
}

export interface ConversationDetail extends Conversation {
  messages: ConversationMessage[];
  authors: { id: string; name: string }[];
  /** Outras conversas do mesmo contacto (todos os números e canais) */
  previous: {
    id: string;
    status: ConversationStatus;
    lastMessageAt: string;
    messageCount: number;
    inbox: { name: string; channel: Channel };
  }[];
}

export interface CannedResponse {
  id: string;
  shortcut: string;
  text: string;
}

// ─── Tickets ────────────────────────────────────────────────────────────────

export type TicketStatus = 'OPEN' | 'PENDING' | 'ON_HOLD' | 'RESOLVED' | 'CLOSED';
export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

/** Referência curta a um ticket (chamada, conversa, screen pop, perfil). */
export interface TicketRef {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  priority?: TicketPriority;
}

export interface Ticket extends TicketRef {
  priority: TicketPriority;
  description: string | null;
  supportLevel: number;
  source: string;
  categoryId: string | null;
  subcategoryId: string | null;
  contactId: string | null;
  assigneeId: string | null;
  groupId: string | null;
  dueAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  reopenCount: number;
  externalSystem: string | null;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
  contact: { id: string; name: string | null; phone: string | null; email: string | null } | null;
  assignee: { id: string; name: string } | null;
  group: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
  subcategory: { id: string; name: string } | null;
}

export type TicketEventType =
  | 'CREATED' | 'STATUS' | 'PRIORITY' | 'LEVEL' | 'ASSIGNEE' | 'GROUP'
  | 'CATEGORY' | 'SUBJECT' | 'NOTE' | 'LINKED' | 'UNLINKED';

export interface TicketDetail extends Ticket {
  /** Calculado pela API com o papel de quem pede (o agente só altera os seus). */
  canEdit: boolean;
  events: { id: string; type: TicketEventType; fromValue: string | null; toValue: string | null; body: string | null; createdAt: string; author: { id: string; name: string } | null }[];
  calls: { id: string; kind: CallKind; status: CallStatus; fromNumber: string | null; toNumber: string; startedAt: string | null; durationSecs: number; createdAt: string }[];
  conversations: { id: string; status: ConversationStatus; lastMessageAt: string; inbox: { name: string; channel: Channel } }[];
}

export interface TicketMeta {
  users: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  categories: { id: string; parentId: string | null; name: string }[];
}
