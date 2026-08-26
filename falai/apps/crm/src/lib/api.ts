import type {
  Agent,
  AgentEditorFields,
  AgentVersion,
  ApiKey,
  Call,
  CallStatus,
  Campaign,
  CampaignContactRow,
  CampaignMode,
  CampaignSchedule,
  CampaignStatus,
  Contact,
  DashboardMetrics,
  Extension,
  ExtensionGroup,
  TelephonyRole,
  TrunkView,
  ImportResult,
  LoginResponse,
  MeResponse,
  Paginated,
  RetryPolicy,
  SimulateRequest,
  SimulateResponse,
  TenantSettings,
  TopupResponse,
  WalletTransaction,
  WebphoneCredentials,
} from '@/types';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

/** Base da API — usada por ligações que não passam por `request` (ex.: EventSource/SSE). */
export const apiBaseUrl = API_BASE;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('falai_token');
  const isFormData = init.body instanceof FormData;
  // Só declarar JSON quando há corpo — evita 400 "Body cannot be empty" em POSTs de ação sem body
  const hasJsonBody = !isFormData && init.body != null;

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (res.status === 401) {
    localStorage.removeItem('falai_token');
    window.dispatchEvent(new CustomEvent('falai:unauthorized'));
    throw new ApiError(401, 'Sessão expirada. Por favor inicie sessão novamente.');
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
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// The backend paginates with limit/offset and wraps list payloads in named keys
// (e.g. `{ agents }`, `{ contacts, total }`). These helpers convert a 1-based
// page number to a limit/offset range and re-wrap the response into the
// `Paginated<T>` shape the pages consume.
const PER_PAGE = 50;

function pageRange(page: number): { limit: number; offset: number } {
  return { limit: PER_PAGE, offset: (page - 1) * PER_PAGE };
}

function toPaginated<T>(items: T[], total: number, page: number): Paginated<T> {
  return { data: items, total, page, perPage: PER_PAGE };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export const authApi = {
  login: (email: string, password: string) =>
    post<LoginResponse>('/tenant/auth/login', { email, password }),

  // The backend expects tenant/owner fields; we derive them from the single form.
  register: (data: { email: string; password: string; name: string; companyName: string; phone: string }) =>
    post<{ tenantId: string; tenantName: string; status: string }>('/tenant/auth/register', {
      tenantName: data.companyName,
      tenantEmail: data.email,
      tenantPhone: data.phone,
      ownerName: data.name,
      ownerEmail: data.email,
      ownerPassword: data.password,
    }),

  me: () => get<MeResponse>('/tenant/auth/me'),

  // The backend identifies the pending 2FA login via the sessionToken from /login.
  twoFaVerify: (sessionToken: string, code: string) =>
    post<{ token: string }>('/tenant/auth/2fa/verify', { sessionToken, code }),

  twoFaSetup: async () => {
    const r = await post<{ secret: string; qrCode: string }>('/tenant/auth/2fa/setup');
    return { secret: r.secret, qrUri: r.qrCode };
  },

  twoFaConfirm: async (code: string) => {
    const r = await post<{ ok: boolean }>('/tenant/auth/2fa/confirm', { code });
    return { success: r.ok };
  },
};

// ─── Dashboard ───────────────────────────────────────────────────────────────

export const dashboardApi = {
  metrics: () => get<DashboardMetrics>('/tenant/dashboard'),
};

// ─── Agents ──────────────────────────────────────────────────────────────────

// The agent form collects flat text fields, but the backend expects the
// `editor` mode payload with a nested `editorFields` object and array-shaped
// dataToCollect/neverSay. A tts voice is required; fall back to the platform
// default (ElevenLabs "Rachel") since the form has no voice picker yet.
const DEFAULT_TTS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

function splitList(v?: string): string[] {
  if (!v) return [];
  return v.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
}

function toAgentEditorPayload(data: Partial<AgentEditorFields>): Record<string, unknown> {
  const editorFields: Record<string, unknown> = {};
  if (data.objective !== undefined) editorFields.objective = data.objective;
  if (data.tone !== undefined) editorFields.tone = data.tone;
  if (data.dataToCollect !== undefined)
    editorFields.dataToCollect = splitList(data.dataToCollect).map((field) => ({ field }));
  if (data.neverSay !== undefined) editorFields.neverSay = splitList(data.neverSay);

  const payload: Record<string, unknown> = {};
  if (data.name !== undefined) payload.name = data.name;
  if (Object.keys(editorFields).length > 0) payload.editorFields = editorFields;
  if (data.maxDurationSecs !== undefined) payload.maxCallSeconds = data.maxDurationSecs;
  if (data.escalationPhone !== undefined) payload.escalationNumber = data.escalationPhone;
  return payload;
}

export const agentsApi = {
  list: async (params?: { page?: number; status?: string }) => {
    const page = params?.page ?? 1;
    const raw = await get<{
      agents: (Agent & { _count?: { versions: number } })[];
      total: number;
    }>(`/tenant/agents${qs({ ...pageRange(page), ...(params?.status ? { status: params.status } : {}) })}`);
    // The list endpoint exposes the version count, not `currentVersion`.
    const agents = raw.agents.map((a) => ({ ...a, currentVersion: a._count?.versions ?? 1 }));
    return toPaginated(agents, raw.total, page);
  },

  get: async (id: string) => (await get<{ agent: Agent }>(`/tenant/agents/${id}`)).agent,

  create: async (data: AgentEditorFields) =>
    (
      await post<{ agent: Agent }>('/tenant/agents', {
        mode: 'editor',
        ttsVoiceId: DEFAULT_TTS_VOICE_ID,
        ...toAgentEditorPayload(data),
      })
    ).agent,

  update: async (id: string, data: Partial<AgentEditorFields>) =>
    (await patch<{ agent: Agent }>(`/tenant/agents/${id}`, toAgentEditorPayload(data))).agent,

  delete: (id: string) => del<void>(`/tenant/agents/${id}`),

  submitReview: (id: string) => post<Agent>(`/tenant/agents/${id}/submit-review`),

  pause: (id: string) => post<Agent>(`/tenant/agents/${id}/pause`),

  resume: (id: string) => post<Agent>(`/tenant/agents/${id}/resume`),

  simulate: (id: string, data: SimulateRequest) =>
    // Backend expects `userText` + history with roles human/agent and `text`.
    post<SimulateResponse>(`/tenant/agents/${id}/simulate`, {
      userText: data.message,
      variables: data.variables,
      history: data.history.map((m) => ({
        role: m.role === 'assistant' ? 'agent' : 'human',
        text: m.content,
      })),
    }),

  versions: (id: string) => get<AgentVersion[]>(`/tenant/agents/${id}/versions`),
};

// ─── Contacts ────────────────────────────────────────────────────────────────

export const contactsApi = {
  list: async (params?: { page?: number; search?: string; optedOut?: boolean }) => {
    const page = params?.page ?? 1;
    const raw = await get<{ contacts: Contact[]; total: number }>(
      `/tenant/contacts${qs({ ...pageRange(page), search: params?.search, optedOut: params?.optedOut })}`,
    );
    return toPaginated(raw.contacts, raw.total, page);
  },

  get: async (id: string) => (await get<{ contact: Contact }>(`/tenant/contacts/${id}`)).contact,

  create: async (data: Partial<Contact>) =>
    (await post<{ contact: Contact }>('/tenant/contacts', data)).contact,

  update: async (id: string, data: Partial<Contact>) =>
    (await patch<{ contact: Contact }>(`/tenant/contacts/${id}`, data)).contact,

  delete: (id: string) => del<void>(`/tenant/contacts/${id}`),

  import: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return post<ImportResult>('/tenant/contacts/import', fd);
  },

  importStatus: async (jobId: string) => {
    // Backend reports BullMQ `state`/`progress`; map to the { progress, done, result } the page expects.
    const raw = await get<{
      state: string;
      progress: number | object;
      result: { imported: number; skipped: number } | null;
    }>(`/tenant/contacts/import/${jobId}`);
    return {
      progress: typeof raw.progress === 'number' ? raw.progress : 0,
      done: raw.state === 'completed' || raw.state === 'failed',
      result: raw.result
        ? { imported: raw.result.imported, skipped: raw.result.skipped, errors: [] }
        : undefined,
    };
  },
};

// ─── Calls ───────────────────────────────────────────────────────────────────

export const callsApi = {
  list: async (params?: { page?: number; agentId?: string; status?: CallStatus; campaignId?: string }) => {
    const page = params?.page ?? 1;
    const raw = await get<{ calls: Call[]; total: number }>(
      `/tenant/calls${qs({ ...pageRange(page), agentId: params?.agentId, status: params?.status, campaignId: params?.campaignId })}`,
    );
    return toPaginated(raw.calls, raw.total, page);
  },

  get: async (id: string) => (await get<{ call: Call }>(`/tenant/calls/${id}`)).call,

  create: async (data: { agentId: string; to: string; variables?: Record<string, string>; scheduledAt?: string }) =>
    (await post<{ call: Call }>('/tenant/calls', data)).call,

  cancel: async (id: string) => (await post<{ call: Call }>(`/tenant/calls/${id}/cancel`)).call,

  // Chamadas directas (click-to-call, sem agente)
  extensions: async () =>
    (await get<{ extensions: { number: string; name: string }[] }>('/tenant/calls/extensions')).extensions,

  direct: async (data: { fromExtension: string; to: string }) =>
    post<{ providerCallId: string; from: string; to: string }>('/tenant/calls/direct', data),

  directHangup: async (providerCallId: string) =>
    post<{ ok: boolean }>('/tenant/calls/direct/hangup', { providerCallId }),

  directStatus: async (callId: string) =>
    get<{ active: boolean }>(`/tenant/calls/direct/status/${encodeURIComponent(callId)}`),
};

// ─── Webphone (WebRTC no browser) ────────────────────────────────────────────

export const webphoneApi = {
  getCredentials: (extensionId: string) =>
    get<WebphoneCredentials>(`/tenant/extensions/${encodeURIComponent(extensionId)}/webphone-credentials`),
};

// ─── Integração PBX (bring-your-own-PBX) ─────────────────────────────────────

export interface PbxConfig {
  productType: 'VOICE_AI' | 'CRM_BYO_PBX';
  config: {
    baseUrl: string | null;
    clientId: string | null;
    extension: string | null;
    secretSet: boolean;
    connected: boolean;
    webhookUrl: string | null;
  };
}

export const pbxApi = {
  get: () => get<PbxConfig>('/tenant/pbx'),

  save: (data: { baseUrl: string; clientId: string; clientSecret?: string; extension?: string }) =>
    put<{ ok: boolean }>('/tenant/pbx', data),

  test: () =>
    post<{ ok: boolean; extensionsCount: number; extensions: { number: string; name: string }[] }>('/tenant/pbx/test'),
};

// ─── Telefonia (módulo PBX nativo: extensões, grupos, funções) ────────────────

export const telephonyApi = {
  // Extensões
  listExtensions: () => get<Extension[]>('/tenant/extensions'),
  getExtension: (id: string) => get<Extension>(`/tenant/extensions/${id}`),
  createExtension: (data: {
    number: string;
    callerId?: string;
    displayName?: string;
    email?: string | null;
    mobile?: string | null;
    roleId?: string | null;
  }) => post<Extension>('/tenant/extensions', data),
  updateExtension: (id: string, data: Partial<Extension>) => put<Extension>(`/tenant/extensions/${id}`, data),
  resetExtensionSip: (id: string) => post<Extension>(`/tenant/extensions/${id}/reset-sip`),
  deleteExtension: (id: string) => del<void>(`/tenant/extensions/${id}`),

  // Grupos
  listGroups: () => get<ExtensionGroup[]>('/tenant/extension-groups'),
  createGroup: (data: { name: string; isDefault?: boolean; memberIds?: string[] }) =>
    post<ExtensionGroup>('/tenant/extension-groups', data),
  updateGroup: (id: string, data: { name?: string; isDefault?: boolean; memberIds?: string[] }) =>
    put<ExtensionGroup>(`/tenant/extension-groups/${id}`, data),
  deleteGroup: (id: string) => del<void>(`/tenant/extension-groups/${id}`),

  // Funções
  listRoles: () => get<TelephonyRole[]>('/tenant/roles'),
  createRole: (data: { name: string; permissions?: Record<string, unknown> }) =>
    post<TelephonyRole>('/tenant/roles', data),
  updateRole: (id: string, data: { name?: string; permissions?: Record<string, unknown> }) =>
    put<TelephonyRole>(`/tenant/roles/${id}`, data),
  deleteRole: (id: string) => del<void>(`/tenant/roles/${id}`),

  // Trunk (só-leitura no produto Voice AI; editável no BYO-PBX)
  listTrunks: () => get<{ productType: string; trunks: TrunkView[] }>('/tenant/trunks'),
  updateTrunk: (id: string, data: Record<string, unknown>) => put<{ trunk: TrunkView }>(`/tenant/trunks/${id}`, data),
};

// ─── Campaigns ───────────────────────────────────────────────────────────────

// The backend campaign status enum differs from the CRM's (RUNNING↔ACTIVE,
// DONE↔COMPLETED, SCHEDULED). Also the model stores `completed` rather than the
// derived counts the pages read. `mapCampaign` normalizes both.
function mapCampaignStatus(s: string): CampaignStatus {
  switch (s) {
    case 'RUNNING':
    case 'SCHEDULED':
      return 'ACTIVE';
    case 'DONE':
      return 'COMPLETED';
    default:
      return s as CampaignStatus; // DRAFT, PAUSED, CANCELLED
  }
}

function mapCampaign(raw: Record<string, unknown>): Campaign {
  const total = (raw.totalContacts as number) ?? 0;
  const completed = (raw.completedCount as number | undefined) ?? (raw.completed as number | undefined) ?? 0;
  const failed = (raw.failedCount as number) ?? 0;
  const s = (raw.scheduleJson ?? {}) as Record<string, unknown>;
  const r = (raw.retryPolicy ?? {}) as Record<string, unknown>;
  return {
    ...(raw as unknown as Campaign),
    status: mapCampaignStatus(raw.status as string),
    completedCount: completed,
    failedCount: failed,
    answeredCount: (raw.answeredCount as number | undefined) ?? 0,
    pendingCount: (raw.pendingCount as number | undefined) ?? Math.max(0, total - completed - failed),
    skippedCount: (raw.skippedCount as number | undefined) ?? 0,
    optedOutCount: (raw.optedOutCount as number | undefined) ?? 0,
    attemptedCount: (raw.attemptedCount as number | undefined) ?? completed + failed,
    actualCostCents: (raw.actualCostCents as number | undefined) ?? 0,
    mode: (raw.mode as Campaign['mode']) ?? 'VOICE_AI',
    scriptText: (raw.scriptText as string | null) ?? null,
    ttsVoiceId: (raw.ttsVoiceId as string | null) ?? null,
    // Backend stores `days`/`retryDelayMinutes`; normalize + default so the UI never reads null.
    scheduleJson: {
      mode: (s.mode as 'NOW' | 'WINDOW') ?? 'WINDOW',
      startHour: (s.startHour as number) ?? 8,
      endHour: (s.endHour as number) ?? 20,
      timezone: (s.timezone as string) ?? 'Africa/Luanda',
      daysOfWeek: (s.daysOfWeek as number[]) ?? (s.days as number[]) ?? [1, 2, 3, 4, 5],
    },
    retryPolicy: {
      maxAttempts: (r.maxAttempts as number) ?? 1,
      delayMinutes: (r.delayMinutes as number) ?? (r.retryDelayMinutes as number) ?? 60,
      retryOn: (r.retryOn as Campaign['retryPolicy']['retryOn']) ?? [],
    },
  };
}

export const campaignsApi = {
  list: async (params?: { page?: number; status?: string }) => {
    const page = params?.page ?? 1;
    const raw = await get<{ campaigns: Record<string, unknown>[]; total: number }>(
      `/tenant/campaigns${qs({ ...pageRange(page), status: params?.status })}`,
    );
    return toPaginated(raw.campaigns.map(mapCampaign), raw.total, page);
  },

  get: async (id: string) =>
    mapCampaign((await get<{ campaign: Record<string, unknown> }>(`/tenant/campaigns/${id}`)).campaign),

  create: async (data: {
    name: string;
    mode?: CampaignMode;
    agentId?: string;
    scriptText?: string;
    ttsVoiceId?: string;
    contactIds?: string[];
    scheduleJson: CampaignSchedule;
    retryPolicy: RetryPolicy;
    throttlePerMinute: number;
  }) => {
    // Backend uses `schedule`/`retryDelayMinutes` and adds contacts via a separate call.
    const raw = await post<{ campaign: Record<string, unknown> }>('/tenant/campaigns', {
      name: data.name,
      mode: data.mode ?? 'VOICE_AI',
      ...(data.agentId && { agentId: data.agentId }),
      ...(data.scriptText && { scriptText: data.scriptText }),
      ...(data.ttsVoiceId && { ttsVoiceId: data.ttsVoiceId }),
      throttlePerMinute: data.throttlePerMinute,
      schedule: {
        mode: data.scheduleJson.mode ?? 'WINDOW',
        startHour: data.scheduleJson.startHour,
        endHour: data.scheduleJson.endHour,
        days: data.scheduleJson.daysOfWeek,
        timezone: data.scheduleJson.timezone,
      },
      retryPolicy: {
        maxAttempts: data.retryPolicy.maxAttempts,
        retryDelayMinutes: data.retryPolicy.delayMinutes,
      },
    });
    const campaign = mapCampaign(raw.campaign);
    if (data.contactIds && data.contactIds.length > 0) {
      await post(`/tenant/campaigns/${campaign.id}/contacts`, { contactIds: data.contactIds });
    }
    return campaign;
  },

  update: async (id: string, data: Partial<Campaign>) =>
    mapCampaign((await patch<{ campaign: Record<string, unknown> }>(`/tenant/campaigns/${id}`, data)).campaign),

  delete: (id: string) => del<void>(`/tenant/campaigns/${id}`),

  addContacts: (id: string, contactIds: string[]) =>
    post<{ added: number; totalContacts: number }>(`/tenant/campaigns/${id}/contacts`, { contactIds }),

  /** Participantes da campanha, um a um, com o desfecho de cada chamada. */
  contacts: (id: string, params?: { page?: number; status?: string; search?: string }) => {
    const page = params?.page ?? 1;
    return get<{ contacts: CampaignContactRow[]; total: number }>(
      `/tenant/campaigns/${id}/contacts${qs({
        ...pageRange(page),
        status: params?.status,
        search: params?.search,
      })}`,
    );
  },

  removeContact: (id: string, contactId: string) =>
    del<{ ok: boolean; totalContacts: number }>(`/tenant/campaigns/${id}/contacts/${contactId}`),

  removeContacts: (id: string, contactIds: string[]) =>
    post<{ removed: number; skipped: number; totalContacts: number }>(
      `/tenant/campaigns/${id}/contacts/remove`,
      { contactIds },
    ),

  report: async (id: string) => {
    const raw = await get<Record<string, unknown>>(`/tenant/campaigns/${id}/report`);
    return mapCampaign(raw) as Campaign & { summary: string };
  },

  start: (id: string) => post<Campaign>(`/tenant/campaigns/${id}/start`),
  launch: (id: string) => post<{ ok: boolean; pendingContacts: number }>(`/tenant/campaigns/${id}/launch`),
  pause: (id: string) => post<Campaign>(`/tenant/campaigns/${id}/pause`),
  resume: (id: string) => post<Campaign>(`/tenant/campaigns/${id}/resume`),
  cancel: (id: string) => post<Campaign>(`/tenant/campaigns/${id}/cancel`),
  /** scope=FAILED repete só quem falhou ou ficou por tentar; ALL repete tudo. */
  retry: (id: string, scope: 'ALL' | 'FAILED' = 'ALL') =>
    post<{ ok: boolean; totalContacts: number; resetCount: number }>(
      `/tenant/campaigns/${id}/retry`,
      { scope },
    ),

  /** Descarrega a lista completa de participantes em CSV (abre com o token na query). */
  exportContactsCsv: async (id: string, name: string) => {
    const token = localStorage.getItem('falai_token');
    const res = await fetch(`${API_BASE}/tenant/campaigns/${id}/contacts?format=csv`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'Falha ao exportar CSV');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `campanha-${name.replace(/[^\w-]+/g, '_')}-contactos.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },
};

// ─── Wallet ──────────────────────────────────────────────────────────────────

export const walletApi = {
  balance: async () => {
    const raw = await get<{
      balance: { balanceCents: number; creditLimitCents: number; plan: { name: string; pricePerMinuteCents: number; pricePerCallCents: number } };
    }>('/tenant/wallet');
    return raw.balance;
  },

  transactions: async (params?: { page?: number; type?: string }) => {
    const page = params?.page ?? 1;
    const raw = await get<{ transactions: WalletTransaction[]; total: number }>(
      `/tenant/wallet/transactions${qs({ ...pageRange(page), type: params?.type })}`,
    );
    return toPaginated(raw.transactions, raw.total, page);
  },

  topup: (amountCents: number) => post<TopupResponse>('/tenant/wallet/topup', { amountCents }),
};

// ─── Subscrição / Faturação ──────────────────────────────────────────────────

export interface Invoice {
  id: string;
  period: string;
  amountCents: number;
  status: 'PAID' | 'DUE' | 'VOID';
  issuedAt: string;
  paidAt: string | null;
}

export interface BillingSummary {
  subscription: {
    planName: string;
    productType: 'VOICE_AI' | 'CRM_BYO_PBX';
    monthlyFeeCents: number;
    nextBillingAt: string | null;
    balanceCents: number;
    status: 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED';
    dueCount: number;
  };
  invoices: Invoice[];
}

export const billingApi = {
  get: () => get<BillingSummary>('/tenant/billing'),
};

// ─── Team ────────────────────────────────────────────────────────────────────

export const teamApi = {
  list: () => get<import('@/types').TenantUser[]>('/tenant/team'),

  invite: (data: { email: string; name: string; role: import('@/types').TenantRole }) =>
    post<import('@/types').TenantUser>('/tenant/team/invite', data),

  updateRole: (userId: string, role: import('@/types').TenantRole) =>
    patch<import('@/types').TenantUser>(`/tenant/team/${userId}`, { role }),

  remove: (userId: string) => del<void>(`/tenant/team/${userId}`),
};

// ─── API Keys ─────────────────────────────────────────────────────────────────

export const apiKeysApi = {
  list: async () => {
    // Backend returns `{ data: [...] }` with a `label` field instead of `name`.
    const raw = await get<{ data: (Omit<ApiKey, 'name'> & { label: string })[] }>('/tenant/api-keys');
    return raw.data.map((k) => ({ ...k, name: k.label }));
  },

  create: async (data: { name: string; scopes: string[]; allowedCidrs?: string[] }) => {
    // Backend expects `label` and returns the raw key under `key`.
    const raw = await post<Omit<ApiKey, 'name' | 'rawKey'> & { label: string; key: string }>(
      '/tenant/api-keys',
      { label: data.name, scopes: data.scopes, allowedCidrs: data.allowedCidrs ?? [] },
    );
    return { ...raw, name: raw.label, rawKey: raw.key } as ApiKey;
  },

  update: async (id: string, data: { scopes?: string[]; allowedCidrs?: string[] }) => {
    const raw = await patch<Omit<ApiKey, 'name' | 'rawKey'> & { label: string }>(
      `/tenant/api-keys/${id}`,
      data,
    );
    return { ...raw, name: raw.label } as ApiKey;
  },

  delete: (id: string) => del<void>(`/tenant/api-keys/${id}`),
};

// ─── Settings ─────────────────────────────────────────────────────────────────

// ─── Relatórios ───────────────────────────────────────────────────────────────

export interface CallReportSummary {
  from: string;
  to: string;
  totals: {
    total: number;
    inbound: number;
    outbound: number;
    answered: number;
    missed: number;
    avgDurationSecs: number;
    totalTalkSecs: number;
    costCents: number;
  };
  byDay: { date: string; total: number; answered: number }[];
  byOutcome: { outcome: string; count: number }[];
  byDirection: { direction: 'inbound' | 'outbound' | 'internal'; count: number }[];
  sms: { total: number; sent: number; failed: number; costCents: number };
}

export const reportsApi = {
  summary: (params?: { from?: string; to?: string }) =>
    get<CallReportSummary>(`/tenant/reports${qs({ from: params?.from, to: params?.to })}`),

  /** Descarrega o CSV das chamadas do intervalo (mantém a autenticação via header). */
  downloadCsv: async (params?: { from?: string; to?: string }) => {
    const token = localStorage.getItem('falai_token');
    const res = await fetch(`${API_BASE}/tenant/reports/calls.csv${qs({ from: params?.from, to: params?.to })}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'Erro ao exportar CSV');
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const match = /filename="?([^"]+)"?/.exec(disposition);
    return { blob, filename: match?.[1] ?? 'chamadas.csv' };
  },
};

// ─── SMS ──────────────────────────────────────────────────────────────────────

import type { SmsMessage, SmsCampaign, SmsConfig, SmsStatus } from '@/types';

export const smsApi = {
  config: () => get<SmsConfig>('/tenant/sms/config'),

  list: async (params?: { page?: number; status?: string }) => {
    const page = params?.page ?? 1;
    const raw = await get<{ messages: SmsMessage[]; total: number }>(
      `/tenant/sms${qs({ ...pageRange(page), status: params?.status })}`,
    );
    return toPaginated(raw.messages, raw.total, page);
  },

  preview: (body: string) => post<{ segments: number; costCents: number; chars: number }>('/tenant/sms/preview', { body }),

  send: (data: { to: string; body: string; contactId?: string }) =>
    post<{ sms: { id: string; status: SmsStatus; segments: number; costCents: number } }>('/tenant/sms', data),

  // Campanhas
  campaigns: () => get<{ campaigns: SmsCampaign[] }>('/tenant/sms/campaigns').then((r) => r.campaigns),

  campaign: (id: string) => get<{ campaign: SmsCampaign }>(`/tenant/sms/campaigns/${id}`).then((r) => r.campaign),

  createCampaign: (data: { name: string; body: string; contactIds?: string[]; throttlePerMinute?: number }) =>
    post<{ id: string }>('/tenant/sms/campaigns', data),

  addCampaignContacts: (id: string, contactIds: string[]) =>
    post<{ added: number }>(`/tenant/sms/campaigns/${id}/contacts`, { contactIds }),

  startCampaign: (id: string) => post<{ ok: boolean }>(`/tenant/sms/campaigns/${id}/start`),

  cancelCampaign: (id: string) => post<{ ok: boolean }>(`/tenant/sms/campaigns/${id}/cancel`),
};

export const settingsApi = {
  get: () => get<TenantSettings>('/tenant/settings'),

  update: (data: Partial<TenantSettings>) => patch<TenantSettings>('/tenant/settings', data),

  rotateSecret: () => post<{ webhookSecret: string }>('/tenant/settings/rotate-secret'),

  testWebhook: () => post<{ delivered: boolean; statusCode?: number }>('/tenant/settings/webhook-test'),

  webhookEvents: async (params?: { page?: number }) => {
    const page = params?.page ?? 1;
    // Backend returns `{ data, total, limit, offset }` with the error text under `message`.
    const raw = await get<{
      data: { id: string; payload: unknown; message: string; createdAt: string }[];
      total: number;
    }>(`/tenant/webhook-events${qs(pageRange(page))}`);
    const events = raw.data.map((e) => ({ id: e.id, payload: e.payload, error: e.message, createdAt: e.createdAt }));
    return toPaginated(events, raw.total, page);
  },
};
