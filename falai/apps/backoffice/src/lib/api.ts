import type {
  AdminDashboardMetrics,
  AdminLoginResponse,
  AdminUser,
  Agent,
  AgentReviewStatus,
  AuditLog,
  BillingMode,
  Call,
  Campaign,
  CampaignDetail,
  FinanceSummary,
  HealthStatus,
  MarginRow,
  Paginated,
  Plan,
  ProviderBalance,
  ProviderTopUp,
  ProductType,
  Product,
  ProductInput,
  SystemEvent,
  SystemSetting,
  Tenant,
  TenantFeatures,
  TenantLine,
  TenantLineInput,
  AgentStatus,
  TenantApiKey,
  IvrMenu,
  InboundRoute,
  RoutingOptions,
  TenantModel,
  TenantUser,
  TenantUserInput,
  AccessProfile,
  AccessProfileInput,
  FeatureKey,
  Trunk,
  EngineStatus,
  WalletTransaction,
  TenantExtension,
  TenantExtensionInput,
} from '@/types';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('falai_admin_token');
  // Só declarar JSON quando há corpo — evita 400 "Body cannot be empty" em POSTs de ação sem body
  const hasJsonBody = !(init.body instanceof FormData) && init.body != null;
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  // Um 401 só significa sessão expirada quando a chamada ia autenticada com
  // token. Sem token (ex.: /admin/auth/login com password errada) é só uma
  // credencial inválida — mostrar a mensagem do backend em vez de mascará-la.
  if (res.status === 401 && token) {
    localStorage.removeItem('falai_admin_token');
    window.dispatchEvent(new CustomEvent('falai:admin:unauthorized'));
    throw new ApiError(401, 'Sessão expirada');
  }

  if (!res.ok) {
    // A API devolve `{ error }` na generalidade das rotas e `{ message }` nos
    // erros de validação do Fastify — aceitar ambos.
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new ApiError(res.status, body.error ?? body.message ?? 'Erro desconhecido');
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body) });
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export const authApi = {
  login: (email: string, password: string) =>
    post<AdminLoginResponse>('/admin/auth/login', { email, password }),

  me: () => get<AdminUser>('/admin/auth/me'),

  twoFaVerify: (sessionToken: string, code: string) =>
    post<{ token: string }>('/admin/auth/2fa/verify', { sessionToken, code }),
};

// ─── Dashboard ───────────────────────────────────────────────────────────────

export const dashboardApi = {
  metrics: () => get<AdminDashboardMetrics>('/admin/dashboard/metrics'),
};

// ─── Tenants ─────────────────────────────────────────────────────────────────

export const tenantsApi = {
  list: (params?: { page?: number; perPage?: number; status?: string; search?: string }) =>
    get<Paginated<Tenant>>(
      `/admin/tenants${qs({ page: params?.page ?? 1, perPage: params?.perPage ?? 20, status: params?.status, search: params?.search })}`,
    ),

  get: (id: string) => get<Tenant>(`/admin/tenants/${id}`),

  create: (data: {
    name: string;
    email: string;
    phone: string;
    nif?: string;
    planId: string;
    ownerName: string;
    ownerEmail: string;
    ownerPassword: string;
    creditLimitCents?: number;
    maxConcurrent?: number;
  }) => post<Tenant>('/admin/tenants', data),

  update: (id: string, data: Partial<Tenant>) =>
    patch<Tenant>(`/admin/tenants/${id}`, data),

  suspend: (id: string, reason?: string) =>
    post<Tenant>(`/admin/tenants/${id}/suspend`, { reason }),

  reactivate: (id: string) =>
    post<Tenant>(`/admin/tenants/${id}/reactivate`),

  adjustBalance: (id: string, data: { amountCents: number; note: string }) =>
    post<{ balanceCents: number }>(`/admin/tenants/${id}/adjust-balance`, data),

  calls: (id: string, params?: { page?: number; perPage?: number }) =>
    get<Paginated<Call>>(`/admin/tenants/${id}/calls${qs({ page: params?.page ?? 1, perPage: params?.perPage ?? 10 })}`),

  campaigns: (id: string, params?: { page?: number; perPage?: number }) =>
    get<Paginated<Campaign>>(`/admin/tenants/${id}/campaigns${qs({ page: params?.page ?? 1, perPage: params?.perPage ?? 10 })}`),

  campaign: (id: string, campaignId: string) => get<CampaignDetail>(`/admin/tenants/${id}/campaigns/${campaignId}`),

  transactions: (id: string, params?: { page?: number; perPage?: number }) =>
    get<Paginated<WalletTransaction>>(
      `/admin/tenants/${id}/transactions${qs({ page: params?.page ?? 1, perPage: params?.perPage ?? 10 })}`,
    ),

  // Linhas de chamadas
  lines: (id: string) => get<{ data: TenantLine[] }>(`/admin/tenants/${id}/lines`),

  createLine: (id: string, data: TenantLineInput) =>
    post<TenantLine>(`/admin/tenants/${id}/lines`, data),

  updateLine: (id: string, lineId: string, data: Partial<TenantLineInput>) =>
    patch<TenantLine>(`/admin/tenants/${id}/lines/${lineId}`, data),

  deleteLine: (id: string, lineId: string) =>
    del<{ ok: boolean }>(`/admin/tenants/${id}/lines/${lineId}`),

  // Funcionalidades
  updateLogo: (id: string, logoDataUrl: string | null) =>
    put<{ logoDataUrl: string | null }>(`/admin/tenants/${id}/logo`, { logoDataUrl }),

  updateFeatures: (id: string, features: Partial<TenantFeatures>) =>
    put<{ featureOverrides: Partial<TenantFeatures>; features: TenantFeatures }>(
      `/admin/tenants/${id}/features`,
      features,
    ),

  // Utilizadores
  users: (id: string) =>
    get<{ users: TenantUser[] }>(`/admin/tenants/${id}/users`).then((r) => r.users),

  createUser: (id: string, data: TenantUserInput) =>
    post<TenantUser>(`/admin/tenants/${id}/users`, data),

  resetUserPassword: (id: string, userId: string, password: string) =>
    post<{ ok: boolean }>(`/admin/tenants/${id}/users/${userId}/reset-password`, { password }),

  setUserAccessProfile: (id: string, userId: string, accessProfileId: string | null) =>
    put<{ ok: true; accessProfileId: string | null }>(`/admin/tenants/${id}/users/${userId}/access-profile`, { accessProfileId }),

  // Perfis de acesso ao CRM
  accessProfiles: (id: string) =>
    get<{ profiles: AccessProfile[]; modules: { key: FeatureKey; label: string; hint: string }[] }>(`/admin/tenants/${id}/access-profiles`),

  createAccessProfile: (id: string, data: AccessProfileInput) =>
    post<AccessProfile>(`/admin/tenants/${id}/access-profiles`, data),

  updateAccessProfile: (id: string, profileId: string, data: Partial<AccessProfileInput>) =>
    put<AccessProfile>(`/admin/tenants/${id}/access-profiles/${profileId}`, data),

  deleteAccessProfile: (id: string, profileId: string) =>
    del<void>(`/admin/tenants/${id}/access-profiles/${profileId}`),

  // Pool WhatsApp Active/Standby (só leitura)
  whatsappPool: (id: string) => get<import('@/types').TenantWhatsappPool>(`/admin/tenants/${id}/whatsapp`),
  whatsappCheck: (id: string, inboxId?: string) =>
    post<{ results: { id: string; verdict: string; detail: string }[] }>(`/admin/tenants/${id}/whatsapp/check`, inboxId ? { inboxId } : {}),

  // SMS (gateway Futurix — configurado por cliente)
  smsConfig: (id: string) =>
    get<{ enabled: boolean; senderId: string | null; apiKeySet: boolean; priceSegmentCents: number | null; planPriceSegmentCents: number }>(
      `/admin/tenants/${id}/sms`,
    ),

  saveSmsConfig: (id: string, data: { apiKey?: string; senderId?: string; priceSegmentCents?: number }) =>
    put<{ ok: boolean }>(`/admin/tenants/${id}/sms`, data),

  // Chaves de API — no produto API_BYOM é aqui que se provisiona o acesso do cliente
  apiKeys: (id: string) =>
    get<{ data: TenantApiKey[]; validScopes: string[] }>(`/admin/tenants/${id}/api-keys`),

  createApiKey: (id: string, data: { label: string; scopes: string[]; allowedCidrs: string[] }) =>
    post<TenantApiKey & { key: string; warning: string }>(`/admin/tenants/${id}/api-keys`, data),

  updateApiKey: (id: string, keyId: string, data: { scopes?: string[]; allowedCidrs?: string[] }) =>
    patch<TenantApiKey>(`/admin/tenants/${id}/api-keys/${keyId}`, data),

  revokeApiKey: (id: string, keyId: string) => del<void>(`/admin/tenants/${id}/api-keys/${keyId}`),

  // IVR e rotas de entrada do cliente
  listExtensions: (id: string) => get<TenantExtension[]>(`/admin/tenants/${id}/extensions`),
  createExtension: (id: string, data: TenantExtensionInput) =>
    post<TenantExtension & { sipAuthSecret: string }>(`/admin/tenants/${id}/extensions`, data),
  updateExtension: (id: string, extId: string, data: TenantExtensionInput) =>
    put<TenantExtension>(`/admin/tenants/${id}/extensions/${extId}`, data),
  resetExtensionSip: (id: string, extId: string) =>
    post<TenantExtension & { sipAuthSecret: string }>(`/admin/tenants/${id}/extensions/${extId}/reset-sip`, {}),
  deleteExtension: (id: string, extId: string) => del<void>(`/admin/tenants/${id}/extensions/${extId}`),
  routingOptions: (id: string) => get<RoutingOptions>(`/admin/tenants/${id}/routing-options`),
  listIvr: (id: string) => get<IvrMenu[]>(`/admin/tenants/${id}/ivr`),
  createIvr: (id: string, data: Omit<IvrMenu, 'id'>) => post<{ id: string }>(`/admin/tenants/${id}/ivr`, data),
  updateIvr: (id: string, menuId: string, data: Omit<IvrMenu, 'id'>) => put<{ ok: true }>(`/admin/tenants/${id}/ivr/${menuId}`, data),
  deleteIvr: (id: string, menuId: string) => del<void>(`/admin/tenants/${id}/ivr/${menuId}`),
  uploadIvrAudio: (id: string, menuId: string, wav: Blob) => {
    const fd = new FormData();
    fd.append('file', wav, 'greeting.wav');
    return post<{ ok: true }>(`/admin/tenants/${id}/ivr/${menuId}/audio`, fd);
  },
  removeIvrAudio: (id: string, menuId: string) => del<void>(`/admin/tenants/${id}/ivr/${menuId}/audio`),
  uploadIvrWelcome: (id: string, menuId: string, wav: Blob) => {
    const fd = new FormData();
    fd.append('file', wav, 'welcome.wav');
    return post<{ ok: true }>(`/admin/tenants/${id}/ivr/${menuId}/welcome`, fd);
  },
  removeIvrWelcome: (id: string, menuId: string) => del<void>(`/admin/tenants/${id}/ivr/${menuId}/welcome`),
  getHoldAudio: (id: string) => get<{ enabled: boolean }>(`/admin/tenants/${id}/hold-audio`),
  uploadHoldAudio: (id: string, wav: Blob) => {
    const fd = new FormData();
    fd.append('file', wav, 'hold.wav');
    return post<{ ok: true }>(`/admin/tenants/${id}/hold-audio`, fd);
  },
  removeHoldAudio: (id: string) => del<void>(`/admin/tenants/${id}/hold-audio`),
  listInboundRoutes: (id: string) => get<InboundRoute[]>(`/admin/tenants/${id}/inbound-routes`),
  createInboundRoute: (id: string, data: Omit<InboundRoute, 'id' | 'trunkName'>) =>
    post<{ id: string }>(`/admin/tenants/${id}/inbound-routes`, data),
  updateInboundRoute: (id: string, routeId: string, data: Omit<InboundRoute, 'id' | 'trunkName'>) =>
    put<{ ok: true }>(`/admin/tenants/${id}/inbound-routes/${routeId}`, data),
  deleteInboundRoute: (id: string, routeId: string) => del<void>(`/admin/tenants/${id}/inbound-routes/${routeId}`),
};

// ─── Agents (Moderation) ─────────────────────────────────────────────────────

export const moderationApi = {
  list: (params?: { page?: number; perPage?: number; status?: AgentReviewStatus }) =>
    get<Paginated<Agent>>(
      `/admin/agents${qs({ page: params?.page ?? 1, perPage: params?.perPage ?? 20, status: params?.status })}`,
    ),

  // O backend responde { ok, status } (novo status do agente), não o Agent completo.
  approve: (id: string) => post<ModerationResult>(`/admin/agents/${id}/approve`),

  reject: (id: string, reason: string) =>
    post<ModerationResult>(`/admin/agents/${id}/reject`, { reason }),

  block: (id: string, reason: string) =>
    post<ModerationResult>(`/admin/agents/${id}/block`, { reason }),
};

// ─── Modelos dos clientes (API_BYOM) ─────────────────────────────────────────
// Mesmo ciclo de moderação dos agentes. Nenhum modelo entra numa chamada real
// sem passar por aqui.

export const modelsApi = {
  list: (params?: { page?: number; perPage?: number; status?: AgentStatus; tenantId?: string }) =>
    get<Paginated<TenantModel>>(
      `/admin/models${qs({
        page: params?.page ?? 1,
        perPage: params?.perPage ?? 20,
        status: params?.status,
        tenantId: params?.tenantId,
      })}`,
    ),

  get: (id: string) => get<{ model: TenantModel }>(`/admin/models/${id}`),

  approve: (id: string) => post<ModerationResult>(`/admin/models/${id}/approve`),

  reject: (id: string, reason: string) => post<ModerationResult>(`/admin/models/${id}/reject`, { reason }),

  block: (id: string, reason: string) => post<ModerationResult>(`/admin/models/${id}/block`, { reason }),

  test: (id: string) =>
    post<{ ok: boolean; latencyMs: number; details: string | null }>(`/admin/models/${id}/test`),
};

interface ModerationResult {
  ok: boolean;
  status: string;
}

// ─── Plans ───────────────────────────────────────────────────────────────────

// O backend usa nomes de campos diferentes (pricePerMinuteCents, maxConcurrent)
// e devolve os planos embrulhados em { plans } / { plan }. Traduzimos aqui para
// manter o tipo Plan canónico no frontend.
interface RawPlan {
  id: string;
  name: string;
  productId: string | null;
  productType: ProductType;
  aiAgentsEnabled: boolean;
  clinicEnabled: boolean;
  smsEnabled: boolean;
  billingMode: BillingMode;
  pricePerMinuteCents: number;
  pricePerCallCents: number;
  pricePerSmsCents: number;
  pricePerTextMessageCents?: number;
  monthlyFeeCents: number;
  maxAgents: number;
  maxConcurrent: number;
  isActive: boolean;
}

const toPlan = (p: RawPlan): Plan => ({
  id: p.id,
  name: p.name,
  productId: p.productId ?? null,
  productType: p.productType ?? 'VOICE_AI',
  aiAgentsEnabled: p.aiAgentsEnabled ?? true,
  clinicEnabled: p.clinicEnabled ?? false,
  smsEnabled: p.smsEnabled ?? false,
  billingMode: p.billingMode ?? 'PER_MINUTE',
  pricePerMinCents: p.pricePerMinuteCents,
  pricePerCallCents: p.pricePerCallCents ?? 0,
  pricePerSmsCents: p.pricePerSmsCents ?? 0,
  pricePerTextMessageCents: p.pricePerTextMessageCents ?? 0,
  monthlyFeeCents: p.monthlyFeeCents,
  maxAgents: p.maxAgents,
  maxConcurrentCalls: p.maxConcurrent,
  isActive: p.isActive,
});

const toRawPlanBody = (data: Partial<Omit<Plan, 'id' | 'isActive'>>) => ({
  ...(data.name !== undefined && { name: data.name }),
  ...(data.productId !== undefined && { productId: data.productId }),
  ...(data.productType !== undefined && { productType: data.productType }),
  ...(data.aiAgentsEnabled !== undefined && { aiAgentsEnabled: data.aiAgentsEnabled }),
  ...(data.clinicEnabled !== undefined && { clinicEnabled: data.clinicEnabled }),
  ...(data.smsEnabled !== undefined && { smsEnabled: data.smsEnabled }),
  ...(data.billingMode !== undefined && { billingMode: data.billingMode }),
  ...(data.pricePerMinCents !== undefined && { pricePerMinuteCents: data.pricePerMinCents }),
  ...(data.pricePerCallCents !== undefined && { pricePerCallCents: data.pricePerCallCents }),
  ...(data.pricePerSmsCents !== undefined && { pricePerSmsCents: data.pricePerSmsCents }),
  ...(data.pricePerTextMessageCents !== undefined && { pricePerTextMessageCents: data.pricePerTextMessageCents }),
  ...(data.monthlyFeeCents !== undefined && { monthlyFeeCents: data.monthlyFeeCents }),
  ...(data.maxAgents !== undefined && { maxAgents: data.maxAgents }),
  ...(data.maxConcurrentCalls !== undefined && { maxConcurrent: data.maxConcurrentCalls }),
});

export const plansApi = {
  list: () => get<{ plans: RawPlan[] }>('/admin/plans').then((r) => r.plans.map(toPlan)),

  create: (data: Omit<Plan, 'id' | 'isActive'>) =>
    post<{ plan: RawPlan }>('/admin/plans', toRawPlanBody(data)).then((r) => toPlan(r.plan)),

  update: (id: string, data: Partial<Omit<Plan, 'id' | 'isActive'>>) =>
    patch<{ plan: RawPlan }>(`/admin/plans/${id}`, toRawPlanBody(data)).then((r) => toPlan(r.plan)),

  delete: (id: string) => del<void>(`/admin/plans/${id}`),
};

// ─── Products ────────────────────────────────────────────────────────────────

type RawProduct = Omit<Product, 'planCount'> & { _count?: { plans: number } };

const toProduct = (p: RawProduct): Product => {
  const { _count, ...rest } = p;
  return { ...rest, planCount: _count?.plans ?? 0 };
};

export const productsApi = {
  list: () => get<{ products: RawProduct[] }>('/admin/products').then((r) => r.products.map(toProduct)),

  create: (data: ProductInput) =>
    post<{ product: RawProduct }>('/admin/products', data).then((r) => toProduct(r.product)),

  update: (id: string, data: Partial<ProductInput>) =>
    patch<{ product: RawProduct }>(`/admin/products/${id}`, data).then((r) => toProduct(r.product)),

  delete: (id: string) => del<void>(`/admin/products/${id}`),
};

// ─── Trunks (módulo PBX nativo) ──────────────────────────────────────────────

export type TrunkInput = Partial<Omit<Trunk, 'id' | 'shared' | 'dids' | 'secretSet' | 'createdAt' | 'updatedAt' | 'tenantId'>> & {
  authSecret?: string;
  /**
   * Cliente dono do trunk (o único que o vê no CRM). Na criação, ausente =
   * partilhado do operador; na edição, null = passa a partilhado. O backend
   * recusa a mudança se houver rotas de outro cliente a usar o trunk.
   */
  tenantId?: string | null;
};

export const trunksApi = {
  list: () => get<{ trunks: Trunk[] }>('/admin/trunks').then((r) => r.trunks),
  get: (id: string) => get<{ trunk: Trunk }>(`/admin/trunks/${id}`).then((r) => r.trunk),
  create: (data: TrunkInput) => post<{ trunk: Trunk }>('/admin/trunks', data).then((r) => r.trunk),
  update: (id: string, data: TrunkInput) => put<{ trunk: Trunk }>(`/admin/trunks/${id}`, data).then((r) => r.trunk),
  delete: (id: string) => del<void>(`/admin/trunks/${id}`),
  addDid: (id: string, did: string, name?: string) => post<{ did: { id: string; did: string; name: string | null } }>(`/admin/trunks/${id}/dids`, { did, name }),
  removeDid: (id: string, didId: string) => del<void>(`/admin/trunks/${id}/dids/${didId}`),
  engineStatus: () => get<EngineStatus>('/admin/trunks/engine-status'),
};

// ─── Chamada de teste ────────────────────────────────────────────────────────
// Marca pelo caminho real (API → adaptador → trunk → operador), que é o mesmo
// que as campanhas e o agente de IA usam. É a prova de que a plataforma
// telefona — e não apenas de que o trunk está registado.

export type TestCallResult = {
  callId: string;
  providerCallId: string;
  status: string;
  message: string;
};

export const testCallApi = {
  dial: (toNumber: string) => post<TestCallResult>('/admin/test-call', { toNumber }),
};

// ─── System Settings ─────────────────────────────────────────────────────────

export const settingsApi = {
  list: () =>
    get<{ settings: SystemSetting[] }>('/admin/settings').then((r) => r.settings),

  set: (key: string, value: string, isSecret?: boolean) =>
    put<{ ok: boolean }>('/admin/settings', { key, value, ...(isSecret !== undefined && { isSecret }) }),

  delete: (key: string) => del<void>(`/admin/settings/${encodeURIComponent(key)}`),
};

// ─── Finance ─────────────────────────────────────────────────────────────────

export const financeApi = {
  summary: (params: { from: string; to: string }) =>
    get<FinanceSummary>(`/admin/finance/summary${qs({ from: params.from, to: params.to })}`),

  transactions: (params?: { page?: number; type?: string; tenantId?: string }) =>
    get<Paginated<WalletTransaction>>(
      `/admin/finance/transactions${qs({ page: params?.page ?? 1, type: params?.type, tenantId: params?.tenantId })}`,
    ),

  marginReport: (params: { from: string; to: string }) =>
    get<MarginRow[]>(`/admin/finance/margin-report${qs({ from: params.from, to: params.to })}`),

  providerBalance: () => get<ProviderBalance>('/admin/finance/provider-balance'),

  updateProviderCost: (costPerCallCents: number) =>
    put<{ ok: true; costPerCallCents: number }>('/admin/finance/provider-cost', { costPerCallCents }),

  addProviderTopup: (data: { amountCents: number; note?: string }) =>
    post<ProviderTopUp>('/admin/finance/provider-topup', data),
};

// ─── Health ──────────────────────────────────────────────────────────────────

export const healthApi = {
  status: () => get<HealthStatus>('/admin/health/providers'),
};

// ─── System Events ────────────────────────────────────────────────────────────

export const eventsApi = {
  list: (params?: { page?: number; severity?: string; source?: string }) =>
    get<Paginated<SystemEvent>>(
      `/admin/system-events${qs({ page: params?.page ?? 1, severity: params?.severity, source: params?.source })}`,
    ),
};

// ─── Audit ───────────────────────────────────────────────────────────────────

export const auditApi = {
  list: (params?: {
    page?: number;
    perPage?: number;
    search?: string;
    actorType?: string;
    action?: string;
    tenantId?: string;
    from?: string;
    to?: string;
  }): Promise<Paginated<AuditLog>> => {
    // O backend pagina por limit/offset e responde { data, total, limit, offset }.
    // Traduzimos de/para page/perPage para manter o tipo Paginated no frontend.
    const page = params?.page ?? 1;
    const perPage = params?.perPage ?? 25;
    return get<{ data: AuditLog[]; total: number }>(
      `/admin/audit${qs({
        limit: perPage,
        offset: (page - 1) * perPage,
        search: params?.search,
        actorType: params?.actorType,
        action: params?.action,
        tenantId: params?.tenantId,
        from: params?.from,
        to: params?.to,
      })}`,
    ).then((r) => ({ data: r.data, total: r.total, page, perPage }));
  },
};

// ─── Calls ───────────────────────────────────────────────────────────────────

export const callsApi = {
  get: (id: string) => get<Call>(`/admin/calls/${id}`),

  list: (params?: { page?: number; tenantId?: string; status?: string; dateFrom?: string; dateTo?: string }) =>
    get<Paginated<Call>>(
      `/admin/calls${qs({
        page: params?.page ?? 1,
        tenantId: params?.tenantId,
        status: params?.status,
        dateFrom: params?.dateFrom,
        dateTo: params?.dateTo,
      })}`,
    ),
};

// ─── Funcionalidades (matriz clientes × funcionalidades) ─────────────────────

export interface FeatureMatrix {
  features: { key: import('@/types').FeatureKey; label: string; hint: string; default: boolean }[];
  tenants: {
    id: string;
    name: string;
    status: string;
    plan: { name: string; productType: string } | null;
    features: import('@/types').TenantFeatures;
    overrides: Partial<import('@/types').TenantFeatures>;
    lockedByPlan: import('@/types').FeatureKey[];
  }[];
}

export const featuresApi = {
  matrix: () => get<FeatureMatrix>('/admin/tenants/features'),
  set: (tenantId: string, changes: Partial<import('@/types').TenantFeatures>) =>
    patch<{ overrides: Partial<import('@/types').TenantFeatures> }>(`/admin/tenants/${tenantId}/features`, changes),
};
