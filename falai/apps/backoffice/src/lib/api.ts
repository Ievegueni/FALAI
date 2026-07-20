import type {
  AdminDashboardMetrics,
  AdminLoginResponse,
  AdminUser,
  Agent,
  AgentReviewStatus,
  AuditLog,
  BillingMode,
  Call,
  FinanceSummary,
  HealthStatus,
  MarginRow,
  Paginated,
  Plan,
  ProductType,
  SystemEvent,
  SystemSetting,
  Tenant,
  TenantFeatures,
  TenantLine,
  TenantLineInput,
  TenantUser,
  TenantUserInput,
  WalletTransaction,
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

  if (res.status === 401) {
    localStorage.removeItem('falai_admin_token');
    window.dispatchEvent(new CustomEvent('falai:admin:unauthorized'));
    throw new ApiError(401, 'Sessão expirada');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new ApiError(res.status, body.message ?? 'Erro desconhecido');
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });
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
  productType: ProductType;
  aiAgentsEnabled: boolean;
  clinicEnabled: boolean;
  billingMode: BillingMode;
  pricePerMinuteCents: number;
  pricePerCallCents: number;
  monthlyFeeCents: number;
  maxAgents: number;
  maxConcurrent: number;
  isActive: boolean;
}

const toPlan = (p: RawPlan): Plan => ({
  id: p.id,
  name: p.name,
  productType: p.productType ?? 'VOICE_AI',
  aiAgentsEnabled: p.aiAgentsEnabled ?? true,
  clinicEnabled: p.clinicEnabled ?? false,
  billingMode: p.billingMode ?? 'PER_MINUTE',
  pricePerMinCents: p.pricePerMinuteCents,
  pricePerCallCents: p.pricePerCallCents ?? 0,
  monthlyFeeCents: p.monthlyFeeCents,
  maxAgents: p.maxAgents,
  maxConcurrentCalls: p.maxConcurrent,
  isActive: p.isActive,
});

const toRawPlanBody = (data: Partial<Omit<Plan, 'id' | 'isActive'>>) => ({
  ...(data.name !== undefined && { name: data.name }),
  ...(data.productType !== undefined && { productType: data.productType }),
  ...(data.aiAgentsEnabled !== undefined && { aiAgentsEnabled: data.aiAgentsEnabled }),
  ...(data.clinicEnabled !== undefined && { clinicEnabled: data.clinicEnabled }),
  ...(data.billingMode !== undefined && { billingMode: data.billingMode }),
  ...(data.pricePerMinCents !== undefined && { pricePerMinuteCents: data.pricePerMinCents }),
  ...(data.pricePerCallCents !== undefined && { pricePerCallCents: data.pricePerCallCents }),
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

  list: (params?: { page?: number; tenantId?: string; status?: string }) =>
    get<Paginated<Call>>(
      `/admin/calls${qs({ page: params?.page ?? 1, tenantId: params?.tenantId, status: params?.status })}`,
    ),
};
