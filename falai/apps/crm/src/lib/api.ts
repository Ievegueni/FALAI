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
  IvrMenu,
  InboundRoute,
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

  // Um 401 só significa sessão expirada quando a chamada ia autenticada com
  // token. Sem token (ex.: /tenant/auth/login com password errada) é só uma
  // credencial inválida — mostrar a mensagem do backend em vez de mascará-la.
  if (res.status === 401 && token) {
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

export interface ContactFileResult {
  contacts: { id: string; name: string | null; phone: string; status: 'existing' | 'created' }[];
  summary: { rows: number; valid: number; existing: number; created: number; duplicatesInFile: number; invalid: number };
  invalid: { row: number; raw: string; reason: string }[];
  nameMatches: { row: number; name: string; phone: string; existingPhone: string | null }[];
}

export type ContactCallState = 'ANSWERED' | 'MISSED' | 'REJECTED' | 'IN_PROGRESS';
export interface ContactHistoryFilters {
  from?: string;
  to?: string;
  state?: Exclude<ContactCallState, 'IN_PROGRESS'>;
  categoryId?: string;
  extensionId?: string;
  page?: number;
  pageSize?: number;
}
export interface ContactHistoryRow {
  id: string;
  at: string;
  direction: 'INBOUND' | 'OUTBOUND';
  kind: string;
  agent: string | null;
  group: string | null;
  durationSecs: number | null;
  state: ContactCallState;
  status: string;
  typing: string | null;
  note: string | null;
}
export interface ContactProfile {
  contact: {
    id: string;
    name: string | null;
    phone: string | null;
    email: string | null;
    attributes: Record<string, string> | null;
    optedOutAt: string | null;
    optOutReason: string | null;
    createdAt: string;
    phones: { id: string; phone: string; label: string | null }[];
  };
  summary: {
    total: number;
    answered: number;
    missed: number;
    rejected: number;
    firstContactAt: string | null;
    lastContactAt: string | null;
    topTyping: { label: string; count: number } | null;
    lastTyping: { label: string; at: string; note: string | null } | null;
    topAgent: { extensionId: string | null; name: string; count: number } | null;
  };
  typings: {
    total: number;
    distribution: { id: string; name: string; count: number; pct: number; subs: { id: string; name: string; count: number; pct: number }[] }[];
    timeline: { at: string; label: string; note: string | null; agent: string; callId: string }[];
  };
  filters: { agents: { extensionId: string; name: string }[]; categories: { id: string; name: string }[] };
  notes: { id: string; source: 'NOTE' | 'TYPING'; body: string; at: string; author: string | null; callId: string | null }[];
}

export const contactsApi = {
  list: async (params?: { page?: number; search?: string; optedOut?: boolean }) => {
    const page = params?.page ?? 1;
    const raw = await get<{ contacts: Contact[]; total: number }>(
      `/tenant/contacts${qs({ ...pageRange(page), search: params?.search, optedOut: params?.optedOut })}`,
    );
    return toPaginated(raw.contacts, raw.total, page);
  },

  get: async (id: string) => (await get<{ contact: Contact }>(`/tenant/contacts/${id}`)).contact,

  // ─── Perfil completo do cliente (melhoria 5) ───
  profile: (id: string) => get<ContactProfile>(`/tenant/contacts/${id}/profile`),
  history: (id: string, f: ContactHistoryFilters) =>
    get<{ data: ContactHistoryRow[]; total: number; page: number; pageSize: number }>(`/tenant/contacts/${id}/calls${qs({ ...f })}`),
  exportHistory: async (id: string, f: ContactHistoryFilters) => {
    const token = localStorage.getItem('falai_token');
    const res = await fetch(`${API_BASE}/tenant/contacts/${id}/calls/export.xlsx${qs({ ...f, page: undefined, pageSize: undefined })}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'Erro ao exportar');
    const blob = await res.blob();
    const match = /filename="?([^"]+)"?/.exec(res.headers.get('Content-Disposition') ?? '');
    return { blob, filename: match?.[1] ?? 'historico.xlsx' };
  },
  addPhone: (id: string, phone: string, label?: string) =>
    post<{ id: string; phone: string; label: string | null }>(`/tenant/contacts/${id}/phones`, { phone, ...(label && { label }) }),
  removePhone: (id: string, phoneId: string) => del<void>(`/tenant/contacts/${id}/phones/${phoneId}`),
  /** O outro contacto é absorvido por este (histórico junto; o outro é apagado). */
  merge: (id: string, otherId: string) => post<{ ok: true; moved: Record<string, number> }>(`/tenant/contacts/${id}/merge`, { otherId }),

  /** Ficheiro de números para uma campanha: reutiliza os existentes, cria os que faltam. */
  fromFile: (file: File) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return post<ContactFileResult>('/tenant/contacts/from-file', fd);
  },

  create: async (data: Partial<Contact>) =>
    (await post<{ contact: Contact }>('/tenant/contacts', data)).contact,

  // Um pedido para a lista toda (até 1000). Criar em ciclo estourava o
  // rate-limit global da API e devolvia 429 a meio da importação.
  createMany: (contacts: Array<Partial<Contact>>) =>
    post<{ created: number; skipped: number; received: number; invalid: Array<{ index: number; phone: string; reason: string }> }>(
      '/tenant/contacts/bulk',
      { contacts },
    ),

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

/** Filtros da página Chamadas (ver API: callsFilter.service.ts). */
export interface CallsFilters {
  from?: string;
  to?: string;
  direction?: 'inbound' | 'outbound';
  kind?: 'AI_AGENT' | 'DIRECT' | 'OTP' | 'INBOUND' | 'FIXED_SCRIPT';
  extensionId?: string;
  groupId?: string;
  categoryId?: string;
  q?: string;
}

export const callsApi = {
  list: async (params?: { page?: number; agentId?: string; status?: CallStatus; campaignId?: string } & CallsFilters) => {
    const { page = 1, ...filters } = params ?? {};
    const raw = await get<{ calls: Call[]; total: number }>(`/tenant/calls${qs({ ...pageRange(page), ...filters })}`);
    return toPaginated(raw.calls, raw.total, page);
  },

  /** A lista filtrada em Excel formatado (gerado no servidor). */
  exportXlsx: async (filters: CallsFilters & { status?: CallStatus }) => {
    const token = localStorage.getItem('falai_token');
    const res = await fetch(`${API_BASE}/tenant/calls/export.xlsx${qs({ ...filters })}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'Erro ao exportar');
    const blob = await res.blob();
    const match = /filename="?([^"]+)"?/.exec(res.headers.get('Content-Disposition') ?? '');
    return { blob, filename: match?.[1] ?? 'chamadas.xlsx' };
  },

  get: async (id: string) => (await get<{ call: Call }>(`/tenant/calls/${id}`)).call,

  create: async (data: { agentId: string; to: string; variables?: Record<string, string>; scheduledAt?: string }) =>
    (await post<{ call: Call }>('/tenant/calls', data)).call,

  cancel: async (id: string) => (await post<{ call: Call }>(`/tenant/calls/${id}/cancel`)).call,

  /**
   * Descarrega a gravação. Não se pode pôr o URL directamente num <audio>: a
   * rota é autenticada por header e o elemento não o envia — daí trazer o
   * ficheiro e devolver um object URL para lhe dar como src.
   */
  recording: async (id: string) => {
    const token = localStorage.getItem('falai_token');
    const res = await fetch(`${API_BASE}/tenant/calls/${id}/recording`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'Erro ao obter a gravação');
    return URL.createObjectURL(await res.blob());
  },

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

// ─── Motivos de recusa (relatórios de atendimento) ───────────────────────────

export interface RejectReason {
  id: string;
  label: string;
  isActive: boolean;
  sortOrder: number;
}

// ─── Supervisão em tempo real (melhoria 4) ───────────────────────────────────

export type SupervisionMode = 'LISTEN' | 'WHISPER' | 'BARGE';
export type AgentLiveState = 'IN_CALL' | 'RINGING' | 'WRAP_UP' | 'PAUSED' | 'AVAILABLE' | 'OFFLINE';

export interface SupervisionLive {
  now: string;
  agents: { extensionId: string; number: string; name: string | null; state: AgentLiveState; since: string | null }[];
  calls: {
    callId: string;
    agent: string | null;
    agentNumber: string | null;
    group: string | null;
    customer: string | null;
    number: string | null;
    since: string;
    ownCall: boolean;
    supervision: { sessionId: string; mode: SupervisionMode; status: 'CONNECTING' | 'ACTIVE'; mine: boolean } | null;
  }[];
  kpis: { queued: number; tmeSecs: number | null; missed: number; answered: number };
}

export interface SupervisionLogEntry {
  sessionId: string;
  supervisor: string;
  agent: string | null;
  callId: string;
  customer: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  modes: { mode: SupervisionMode; at: string }[];
}

export const supervisionApi = {
  live: () => get<SupervisionLive>('/tenant/supervision/live'),
  start: (callId: string, mode: SupervisionMode) =>
    post<{ sessionId: string; status: string; mode: SupervisionMode }>(`/tenant/supervision/calls/${callId}`, { mode }),
  setMode: (sessionId: string, mode: SupervisionMode) =>
    patch<{ sessionId: string; mode: SupervisionMode }>(`/tenant/supervision/sessions/${sessionId}`, { mode }),
  end: (sessionId: string) => del<void>(`/tenant/supervision/sessions/${sessionId}`),
  log: (q: { from?: string; to?: string; page: number }) =>
    get<{ total: number; page: number; pageSize: number; data: SupervisionLogEntry[] }>(`/tenant/supervision/log${qs(q)}`),
  settings: () => get<{ supervisionNotifyListen: boolean; monitoringNotice: boolean }>('/tenant/supervision/settings'),
  updateSettings: (data: { supervisionNotifyListen?: boolean; monitoringNotice?: boolean }) =>
    patch<{ supervisionNotifyListen: boolean; monitoringNotice: boolean }>('/tenant/supervision/settings', data),
  uploadNotice: (wav: Blob) => {
    const fd = new FormData();
    fd.append('file', wav, 'aviso.wav');
    return post<{ ok: true }>('/tenant/supervision/notice-audio', fd);
  },
  pause: (extensionId: string) => get<{ paused: boolean; since: string | null }>(`/tenant/supervision/pause${qs({ extensionId })}`),
  setPause: (extensionId: string, paused: boolean) =>
    post<{ paused: boolean }>('/tenant/supervision/pause', { extensionId, paused }),
};

// ─── Painel do cliente na entrada (melhoria 3) ───────────────────────────────

export type CallerInfo =
  | { kind: 'HIDDEN' }
  | { kind: 'NUMBER'; raw: string; national: string | null; display: string };

export interface CallerHistoryItem {
  id: string;
  kind: string;
  at: string;
  agent: string | null;
  group: string | null;
  durationSecs: number;
  state: string; // ANSWERED | MISSED | REJECTED | IN_PROGRESS (entrada) ou o status (saída)
  typing: string | null;
  note: string | null;
}

export interface CallerNote {
  id: string;
  body: string;
  createdAt: string;
  author?: string | null;
  callId: string | null;
}

export interface CallerPanelData {
  caller: CallerInfo;
  callId: string | null;
  contact: {
    id: string;
    name: string | null;
    phone: string | null;
    email: string | null;
    attributes: Record<string, unknown> | null;
    optedOutAt: string | null;
    phones: { id: string; phone: string; label: string | null }[];
  } | null;
  history?: { data: CallerHistoryItem[]; hasMore: boolean };
  highlights?: { callsLast7Days: number; lastTyping: { label: string; at: string; note: string | null } | null };
  conversations?: { id: string; status: string; lastMessageAt: string | null; inbox: { channel: string; name: string } }[];
  notes?: CallerNote[];
}

export const callersApi = {
  lookup: (q: { legId: string } | { number: string }) =>
    get<CallerPanelData>(`/tenant/callers/lookup${qs(q)}`),
  history: (contactId: string, before: string) =>
    get<{ data: CallerHistoryItem[]; hasMore: boolean }>(`/tenant/callers/${contactId}/history${qs({ before, limit: 10 })}`),
  quickCreate: (data: { name: string; phone: string; legId?: string }) => post<{ id: string }>('/tenant/callers/contacts', data),
  update: (contactId: string, data: { name?: string; email?: string | null }) =>
    patch<{ ok: true }>(`/tenant/callers/${contactId}`, data),
  addPhone: (contactId: string, data: { phone: string; label?: string }) =>
    post<{ id: string; phone: string; label: string | null }>(`/tenant/callers/${contactId}/phones`, data),
  removePhone: (contactId: string, phoneId: string) => del<void>(`/tenant/callers/${contactId}/phones/${phoneId}`),
  addNote: (contactId: string, data: { body: string; legId?: string }) =>
    post<CallerNote>(`/tenant/callers/${contactId}/notes`, data),
};

// ─── Tipificação de chamadas (melhoria 2) ────────────────────────────────────

export interface CallCategory {
  id: string;
  parentId: string | null;
  name: string;
  isActive: boolean;
  sortOrder: number;
  groupIds: string[];
}

export type TypingStatus = 'NONE' | 'TYPED' | 'PENDING' | 'NOT_TYPED';

export interface LegTyping {
  id: string;
  from: string | null;
  status: TypingStatus;
  wrapUpEndsAt: string | null;
  categoryId: string | null;
  subcategoryId: string | null;
  note: string | null;
  categories: { id: string; parentId: string | null; name: string }[];
}

export const callTypingApi = {
  categories: () => get<{ data: CallCategory[] }>('/tenant/call-categories').then((r) => r.data),
  createCategory: (data: { name: string; parentId?: string | null; groupIds?: string[]; sortOrder?: number }) =>
    post<CallCategory>('/tenant/call-categories', data),
  updateCategory: (id: string, data: Partial<Pick<CallCategory, 'name' | 'isActive' | 'sortOrder' | 'groupIds'>>) =>
    patch<{ ok: true }>(`/tenant/call-categories/${id}`, data),
  settings: () => get<{ typingRequired: boolean; typingMaxSecs: number }>('/tenant/call-typing/settings'),
  updateSettings: (data: { typingRequired?: boolean; typingMaxSecs?: number }) =>
    patch<{ typingRequired: boolean; typingMaxSecs: number }>('/tenant/call-typing/settings', data),
  untyped: (extensionId: string) =>
    get<{ data: { id: string; from: string | null; at: string; status: TypingStatus; wrapUpEndsAt: string | null }[] }>(
      `/tenant/call-legs/untyped?extensionId=${encodeURIComponent(extensionId)}`,
    ).then((r) => r.data),
  legTyping: (legId: string) => get<LegTyping>(`/tenant/call-legs/${encodeURIComponent(legId)}/typing`),
  saveTyping: (legId: string, data: { categoryId: string; subcategoryId?: string | null; note?: string | null }) =>
    put<{ ok: true; edited: boolean }>(`/tenant/call-legs/${encodeURIComponent(legId)}/typing`, data),
};

export const rejectReasonsApi = {
  list: (all = false) =>
    get<{ data: RejectReason[] }>(`/tenant/reject-reasons${all ? '?all=1' : ''}`).then((r) => r.data),
  create: (data: { label: string; sortOrder?: number }) => post<RejectReason>('/tenant/reject-reasons', data),
  update: (id: string, data: Partial<Pick<RejectReason, 'label' | 'isActive' | 'sortOrder'>>) =>
    patch<{ ok: true }>(`/tenant/reject-reasons/${id}`, data),
  /** Motivo de uma recusa no webphone — `legId` vem do cabeçalho X-Falai-Leg-Id. */
  saveForLeg: (legId: string, data: { reasonId: string } | { note: string }) =>
    post<{ ok: true }>(`/tenant/call-legs/${encodeURIComponent(legId)}/reject-reason`, data),
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

  // Menus IVR
  listIvr: () => get<IvrMenu[]>('/tenant/routing/ivr'),
  createIvr: (data: Omit<IvrMenu, 'id'>) => post<{ id: string }>('/tenant/routing/ivr', data),
  updateIvr: (id: string, data: Omit<IvrMenu, 'id'>) => put<{ ok: true }>(`/tenant/routing/ivr/${id}`, data),
  deleteIvr: (id: string) => del<void>(`/tenant/routing/ivr/${id}`),
  uploadIvrAudio: (id: string, wav: Blob) => {
    const fd = new FormData();
    fd.append('file', wav, 'greeting.wav');
    return post<{ ok: true }>(`/tenant/routing/ivr/${id}/audio`, fd);
  },
  removeIvrAudio: (id: string) => del<void>(`/tenant/routing/ivr/${id}/audio`),
  uploadIvrWelcome: (id: string, wav: Blob) => {
    const fd = new FormData();
    fd.append('file', wav, 'welcome.wav');
    return post<{ ok: true }>(`/tenant/routing/ivr/${id}/welcome`, fd);
  },
  removeIvrWelcome: (id: string) => del<void>(`/tenant/routing/ivr/${id}/welcome`),
  getHoldAudio: () => get<{ enabled: boolean }>('/tenant/routing/hold-audio'),
  uploadHoldAudio: (wav: Blob) => {
    const fd = new FormData();
    fd.append('file', wav, 'hold.wav');
    return post<{ ok: true }>('/tenant/routing/hold-audio', fd);
  },
  removeHoldAudio: () => del<void>('/tenant/routing/hold-audio'),

  // Rotas de entrada (DID → destino)
  listInboundRoutes: () => get<InboundRoute[]>('/tenant/routing/inbound-routes'),
  createInboundRoute: (data: Omit<InboundRoute, 'id' | 'trunkName'>) => post<{ id: string }>('/tenant/routing/inbound-routes', data),
  updateInboundRoute: (id: string, data: Omit<InboundRoute, 'id' | 'trunkName'>) => put<{ ok: true }>(`/tenant/routing/inbound-routes/${id}`, data),
  deleteInboundRoute: (id: string) => del<void>(`/tenant/routing/inbound-routes/${id}`),
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

export interface TeamMemberInput {
  name?: string;
  password?: string;
  role?: import('@/types').TenantRole;
  extensionId?: string | null;
  groupIds?: string[];
  supervisedGroupIds?: string[];
}

export const teamApi = {
  list: () => get<import('@/types').TenantUser[]>('/tenant/team'),

  /** O gestor cria o utilizador já com password (sem convite por email). */
  create: (data: TeamMemberInput & { email: string; name: string; password: string; role: import('@/types').TenantRole }) =>
    post<import('@/types').TenantUser>('/tenant/team', data),

  updateRole: (userId: string, role: import('@/types').TenantRole) =>
    patch<import('@/types').TenantUser>(`/tenant/team/${userId}`, { role }),

  remove: (userId: string) => del<void>(`/tenant/team/${userId}`),

  /** Papel, extensão do utilizador e grupos que supervisiona (melhoria 4). */
  update: (userId: string, data: TeamMemberInput) => patch<import('@/types').TenantUser>(`/tenant/team/${userId}`, data),
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

  // ── Resumo (cartões com comparação, anéis, por dia) ──
  overview: (params: { from?: string; to?: string }) =>
    get<ReportsOverview>(`/tenant/reports/overview${qs({ from: params.from, to: params.to })}`),
  /** O Resumo em Excel já formatado (várias folhas), gerado no servidor. */
  downloadOverviewXlsx: async (params: { from?: string; to?: string }) => {
    const token = localStorage.getItem('falai_token');
    const res = await fetch(`${API_BASE}/tenant/reports/overview.xlsx${qs({ from: params.from, to: params.to })}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'Erro ao gerar o Excel');
    const blob = await res.blob();
    const match = /filename="?([^"]+)"?/.exec(res.headers.get('Content-Disposition') ?? '');
    return { blob, filename: match?.[1] ?? 'relatorio.xlsx' };
  },
  /** PDF do resumo, gerado no servidor (não é uma impressão da página). */
  downloadOverviewPdf: async (params: { from?: string; to?: string }) => {
    const token = localStorage.getItem('falai_token');
    const res = await fetch(`${API_BASE}/tenant/reports/overview.pdf${qs({ from: params.from, to: params.to })}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'Erro ao gerar o PDF');
    const blob = await res.blob();
    const match = /filename="?([^"]+)"?/.exec(res.headers.get('Content-Disposition') ?? '');
    return { blob, filename: match?.[1] ?? 'relatorio.pdf' };
  },

  // ── Atendimento (KPIs por agente/grupo) ──
  attendance: (f: AttendanceFilters) => get<AttendanceReport>(`/tenant/reports/attendance${qs({ ...f })}`),
  attendanceCalls: (f: AttendanceFilters & { page: number; pageSize?: number }) =>
    get<AttendanceCallsPage>(
      `/tenant/reports/attendance/calls${qs({ ...f, pageSize: f.pageSize ?? 25 })}`,
    ),
  downloadAttendance: async (f: AttendanceFilters & { view: 'agents' | 'groups' | 'reasons' | 'typing'; format: 'csv' | 'xlsx' }) => {
    const token = localStorage.getItem('falai_token');
    const res = await fetch(`${API_BASE}/tenant/reports/attendance/export${qs({ ...f })}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'Erro ao exportar');
    const blob = await res.blob();
    const match = /filename="?([^"]+)"?/.exec(res.headers.get('Content-Disposition') ?? '');
    return { blob, filename: match?.[1] ?? `atendimento.${f.format}` };
  },
};

export interface ReportsOverview {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  limited: boolean;
  tiles: {
    key: string;
    value: number | null;
    previous: number | null;
    deltaPct: number | null;
    good: 'up' | 'down' | 'neutral';
    unit: 'count' | 'secs';
    series: (number | null)[];
  }[];
  donuts: Record<'byGroup' | 'byState' | 'byTyping', { label: string; value: number }[]>;
  daily: { date: string; total: number; answered: number }[];
}

export interface AttendanceFilters {
  from?: string;
  to?: string;
  extensionId?: string;
  groupId?: string;
  categoryId?: string;
}

export interface AttendanceCallKpis {
  total: number;
  answered: number;
  missed: number;
  abandoned: number;
  answerRate: number | null;
  tmaSecs: number | null;
  tmeSecs: number | null;
}

export interface AttendanceAgentKpis {
  offered: number;
  answered: number;
  rejected: number;
  noAnswer: number;
  busy: number;
  failed: number;
  cancelled: number;
  answerRate: number | null;
  rejectRate: number | null;
  tmaSecs: number | null;
  tmeSecs: number | null;
  responseSecs: number | null;
  typed: number;
  untyped: number;
  untypedRate: number | null;
  wrapUpSecs: number | null;
}

export interface AttendanceReport {
  from: string;
  to: string;
  limited: boolean;
  tenant: { calls: AttendanceCallKpis; agents: AttendanceAgentKpis };
  selection: { calls: AttendanceCallKpis; agents: AttendanceAgentKpis };
  reasons: { reason: string; count: number; pct: number }[];
  typing: { category: string; subcategory: string | null; count: number; pct: number }[];
  byAgent: (AttendanceAgentKpis & {
    extensionId: string | null;
    number: string;
    name: string | null;
    vsTenant: { answerRate: number | null; rejectRate: number | null; tmaSecs: number | null; responseSecs: number | null };
  })[];
  byGroup: (AttendanceCallKpis & {
    groupId: string | null;
    name: string;
    rejected: number;
    vsTenant: { answerRate: number | null; tmaSecs: number | null; tmeSecs: number | null };
  })[];
}

export type CallLegOutcome = 'ANSWERED' | 'NO_ANSWER' | 'REJECTED' | 'BUSY' | 'CANCELLED' | 'FAILED';

export interface AttendanceCallsPage {
  total: number;
  page: number;
  pageSize: number;
  data: {
    id: string;
    from: string | null;
    contactId: string | null;
    contactName: string | null;
    to: string;
    startedAt: string;
    group: string | null;
    answered: boolean;
    waitSecs: number | null;
    talkSecs: number | null;
    legs: {
      extension: string;
      outcome: CallLegOutcome | null;
      responseSecs: number | null;
      reason: string | null;
      typing: string | null;
      typingNote: string | null;
    }[];
  }[];
}

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

  createCampaign: (data: { name: string; body: string; contactIds?: string[]; allContacts?: boolean; throttlePerMinute?: number }) =>
    post<{ id: string }>('/tenant/sms/campaigns', data),

  addCampaignContacts: (id: string, contactIds: string[]) =>
    post<{ added: number }>(`/tenant/sms/campaigns/${id}/contacts`, { contactIds }),

  startCampaign: (id: string) => post<{ ok: boolean }>(`/tenant/sms/campaigns/${id}/start`),

  cancelCampaign: (id: string) => post<{ ok: boolean }>(`/tenant/sms/campaigns/${id}/cancel`),
};

export const settingsApi = {
  get: () => get<TenantSettings>('/tenant/settings'),

  update: (data: Partial<TenantSettings>) => patch<TenantSettings>('/tenant/settings', data),

  // O backend não tem endpoint dedicado — a rotação é uma flag no PATCH /tenant/settings.
  rotateSecret: () => patch<{ ok: boolean; webhookSecret: string }>('/tenant/settings', { rotateWebhookSecret: true }),

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

// ─── Canais de texto ─────────────────────────────────────────────────────────

type InboxInput = { channel?: import('@/types').Channel; name?: string; agentId?: string | null; autoReply?: boolean; enabled?: boolean; config?: Record<string, unknown> };

export const inboxesApi = {
  list: () => get<{ data: import('@/types').Inbox[] }>('/tenant/inboxes').then((r) => r.data),
  create: (data: InboxInput) => post<import('@/types').Inbox>('/tenant/inboxes', data),
  update: (id: string, data: InboxInput) => patch<import('@/types').Inbox>(`/tenant/inboxes/${id}`, data),
  remove: (id: string) => del<void>(`/tenant/inboxes/${id}`),
  poolAction: (id: string, action: 'activate' | 'standby' | 'disable' | 'check') =>
    post<import('@/types').Inbox | { verdict: string; detail: string }>(`/tenant/inboxes/${id}/wa-pool`, { action }),
  poolOrder: (ids: string[]) => put<void>('/tenant/inboxes/wa-pool/order', { ids }),
};

export const conversationsApi = {
  list: (params: { status?: string; inboxId?: string; assignee?: string }) =>
    get<{ data: import('@/types').Conversation[] }>(`/tenant/conversations${qs(params)}`).then((r) => r.data),
  get: (id: string) => get<import('@/types').ConversationDetail>(`/tenant/conversations/${id}`),
  send: (id: string, text: string, isPrivate = false) =>
    post<import('@/types').ConversationMessage>(`/tenant/conversations/${id}/messages`, { text, private: isPrivate }),
  update: (id: string, data: { status?: string; mode?: string; assigneeId?: string | null; updatedAt: string }) =>
    patch<import('@/types').Conversation>(`/tenant/conversations/${id}`, data),
  /** Anexo protegido por auth — descarrega via fetch e abre como blob. */
  openAttachment: async (file: string) => {
    const token = localStorage.getItem('falai_token');
    const res = await fetch(`${API_BASE}/tenant/conversations/attachments/${encodeURIComponent(file)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'Anexo indisponível');
    window.open(URL.createObjectURL(await res.blob()), '_blank');
  },
};

export const cannedApi = {
  list: () => get<{ data: import('@/types').CannedResponse[] }>('/tenant/canned-responses').then((r) => r.data),
  create: (data: { shortcut: string; text: string }) => post<import('@/types').CannedResponse>('/tenant/canned-responses', data),
  remove: (id: string) => del<void>(`/tenant/canned-responses/${id}`),
};
