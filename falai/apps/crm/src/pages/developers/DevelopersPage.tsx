import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Copy, Trash2, Code2, Webhook, Key, CheckCircle, Play, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';
import { apiKeysApi, settingsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Tabs } from '@/components/ui/Tabs';
import { PageSpinner } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { useToast } from '@/contexts/ToastContext';
import { formatDate } from '@/lib/utils';

const ALL_SCOPES = [
  { key: 'calls:write', label: 'Criar chamadas' },
  { key: 'calls:read', label: 'Ler chamadas' },
  { key: 'otp:call', label: 'Chamadas OTP' },
  { key: 'contacts:write', label: 'Criar/editar contactos' },
  { key: 'contacts:read', label: 'Ler contactos' },
  { key: 'campaigns:write', label: 'Criar campanhas' },
  { key: 'campaigns:read', label: 'Ler campanhas' },
  { key: 'wallet:read', label: 'Ler saldo' },
  { key: 'agents:read', label: 'Ler agentes' },
];

function CreateKeyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['calls:write', 'calls:read']);
  const [rawKey, setRawKey] = useState('');

  const create = useMutation({
    mutationFn: () => apiKeysApi.create({ name, scopes }),
    onSuccess: (key) => {
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
      if (key.rawKey) setRawKey(key.rawKey);
    },
    onError: (e: Error) => error(e.message),
  });

  function toggleScope(s: string) {
    setScopes((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
  }

  function handleClose() {
    setName('');
    setScopes(['calls:write', 'calls:read']);
    setRawKey('');
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Nova API key"
      footer={
        !rawKey ? (
          <>
            <Button variant="ghost" onClick={handleClose}>Cancelar</Button>
            <Button loading={create.isPending} onClick={() => create.mutate()}>Criar</Button>
          </>
        ) : (
          <Button onClick={handleClose}>Fechar</Button>
        )
      }
    >
      {!rawKey ? (
        <div className="flex flex-col gap-4">
          <Input
            label="Nome da chave"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ex: Integração CRM"
            required
            autoFocus
          />
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Permissões (scopes)</p>
            <div className="grid grid-cols-2 gap-2">
              {ALL_SCOPES.map((s) => (
                <label key={s.key} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={scopes.includes(s.key)}
                    onChange={() => toggleScope(s.key)}
                    className="rounded"
                  />
                  {s.label}
                </label>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-emerald-600">
            <CheckCircle className="h-5 w-5" />
            <p className="text-sm font-semibold">Chave criada com sucesso</p>
          </div>
          <div className="rounded-lg bg-gray-900 p-4">
            <p className="font-mono text-sm text-emerald-400 break-all">{rawKey}</p>
          </div>
          <p className="text-xs text-red-600 font-medium">
            Copie esta chave agora. Não será mostrada novamente.
          </p>
          <Button
            size="sm"
            variant="outline"
            icon={<Copy className="h-3.5 w-3.5" />}
            onClick={() => { void navigator.clipboard.writeText(rawKey); }}
          >
            Copiar chave
          </Button>
        </div>
      )}
    </Modal>
  );
}

function ApiKeysList() {
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [showCreate, setShowCreate] = useState(false);

  const { data: keys, isLoading } = useQuery({
    queryKey: ['api-keys'],
    queryFn: apiKeysApi.list,
  });

  const del = useMutation({
    mutationFn: (id: string) => apiKeysApi.delete(id),
    onSuccess: () => { success('Chave revogada'); void qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e: Error) => error(e.message),
  });

  if (isLoading) return <PageSpinner />;

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">{keys?.length ?? 0} chaves</p>
        <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setShowCreate(true)}>
          Nova API key
        </Button>
      </div>

      {keys?.length === 0 ? (
        <div className="text-center py-12 text-sm text-gray-400">Sem API keys. Crie uma para integrar.</div>
      ) : (
        <Card padding={false}>
          <div className="divide-y divide-gray-100">
            {keys?.map((k) => (
              <div key={k.id} className="flex items-center gap-4 px-6 py-3">
                <Key className="h-4 w-4 text-gray-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900">{k.name}</p>
                    <code className="text-xs text-gray-400 bg-gray-100 px-1.5 rounded">{k.prefix}…</code>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {k.scopes.map((s) => (
                      <Badge key={s} className="bg-blue-50 text-blue-700 text-xs">{s}</Badge>
                    ))}
                  </div>
                </div>
                <div className="text-right text-xs text-gray-400">
                  <p>{k.lastUsedAt ? `Usado ${formatDate(k.lastUsedAt)}` : 'Nunca usado'}</p>
                  <p className="mt-0.5">Criado {formatDate(k.createdAt)}</p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
                  loading={del.isPending}
                  onClick={() => { if (confirm(`Revogar "${k.name}"?`)) del.mutate(k.id); }}
                />
              </div>
            ))}
          </div>
        </Card>
      )}
      <CreateKeyModal open={showCreate} onClose={() => setShowCreate(false)} />
    </>
  );
}

function WebhookPanel() {
  const { success, error } = useToast();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.get,
  });

  const testWebhook = useMutation({
    mutationFn: settingsApi.testWebhook,
    onSuccess: (res) => {
      if (res.delivered) success('Webhook entregue com sucesso');
      else error(`Falhou com HTTP ${res.statusCode ?? '?'}`);
    },
    onError: (e: Error) => error(e.message),
  });

  const { data: events, isLoading: loadingEvents } = useQuery({
    queryKey: ['webhook-events'],
    queryFn: () => settingsApi.webhookEvents(),
  });

  if (isLoading) return <PageSpinner />;

  return (
    <div className="space-y-4">
      <Card>
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Configuração do webhook</h3>
        <div className="space-y-3">
          <div>
            <p className="text-xs text-gray-500 mb-1">URL configurada</p>
            <p className="text-sm font-mono text-gray-900">{settings?.webhookUrl ?? 'Não configurado'}</p>
          </div>
          {settings?.webhookSecret && (
            <div>
              <p className="text-xs text-gray-500 mb-1">Secret HMAC (X-Falai-Signature)</p>
              <p className="text-sm font-mono text-gray-400">{'•'.repeat(32)}</p>
            </div>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-3">Para alterar a URL ou o secret, vá a <strong>Definições → Integrações</strong>.</p>
        {settings?.webhookUrl && (
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            icon={<Play className="h-3.5 w-3.5" />}
            loading={testWebhook.isPending}
            onClick={() => testWebhook.mutate()}
          >
            Testar webhook
          </Button>
        )}
      </Card>

      {events && events.data.length > 0 && (
        <Card padding={false}>
          <div className="px-4 py-3 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-900">Dead-letters (entregas falhadas)</h3>
          </div>
          <div className="divide-y divide-gray-100 max-h-64 overflow-y-auto">
            {events.data.map((e) => (
              <div key={e.id} className="px-4 py-2">
                <p className="text-xs text-red-600 font-medium">{e.error}</p>
                <p className="text-xs text-gray-400 mt-0.5">{formatDate(e.createdAt)}</p>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

const METHOD_COLOR: Record<string, string> = {
  GET: 'bg-blue-100 text-blue-700',
  POST: 'bg-emerald-100 text-emerald-700',
  DELETE: 'bg-red-100 text-red-700',
  PATCH: 'bg-amber-100 text-amber-700',
};

type Param = { name: string; type: string; required?: boolean; desc: string };
type EndpointDef = {
  method: string;
  path: string;
  desc: string;
  scope: string;
  params?: Param[];
  body?: string;
  response: string;
};
type EndpointGroup = { label: string; endpoints: EndpointDef[] };

const ENDPOINT_GROUPS: EndpointGroup[] = [
  {
    label: 'Chamadas',
    endpoints: [
      {
        method: 'POST', path: '/v1/calls', desc: 'Iniciar uma chamada de voz com um agente IA', scope: 'calls:write',
        body: `{
  "agent_id": "agt_abc123",   // obrigatório
  "to": "+244923000000",       // obrigatório — número E.164
  "metadata": { "ref": "ord_99" } // opcional
}`,
        response: `{
  "id": "call_xyz789",
  "status": "dialing",
  "to": "+244923000000",
  "agentId": "agt_abc123",
  "createdAt": "2026-07-20T15:00:00.000Z"
}`,
      },
      {
        method: 'GET', path: '/v1/calls/:id', desc: 'Estado, transcript e resultado de uma chamada', scope: 'calls:read',
        params: [{ name: 'id', type: 'string', required: true, desc: 'ID da chamada' }],
        response: `{
  "id": "call_xyz789",
  "status": "COMPLETED",
  "to": "+244923000000",
  "durationSeconds": 42,
  "transcript": "Olá, ligo da Falaí...",
  "result": "SALE",
  "sentiment": "POSITIVE",
  "createdAt": "2026-07-20T15:00:00.000Z"
}`,
      },
      {
        method: 'GET', path: '/v1/calls', desc: 'Listar chamadas com filtros e paginação', scope: 'calls:read',
        params: [
          { name: 'status', type: 'string', desc: 'Filtrar por status (COMPLETED, FAILED, …)' },
          { name: 'agentId', type: 'string', desc: 'Filtrar por agente' },
          { name: 'page', type: 'number', desc: 'Página (default 1)' },
          { name: 'limit', type: 'number', desc: 'Resultados por página (max 100)' },
        ],
        response: `{
  "data": [ { "id": "call_xyz789", "status": "COMPLETED", ... } ],
  "total": 142,
  "page": 1,
  "limit": 20
}`,
      },
    ],
  },
  {
    label: 'OTP por Voz',
    endpoints: [
      {
        method: 'POST', path: '/v1/otp/call', desc: 'Ligar ao utilizador e ditar um código OTP por voz', scope: 'otp:call',
        body: `{
  "to": "+244923000000",   // obrigatório — número E.164
  "code": "483921",        // obrigatório — apenas dígitos
  "language": "pt",        // opcional: "pt" | "en" (default "pt")
  "autoAnswer": "yes"      // opcional: "yes" | "no" (default "yes")
}`,
        response: `{
  "providerCallId": "1748291",
  "callId": "call_otp_001",
  "to": "+244923000000",
  "status": "dialing",
  "message": "Chamada iniciada. O código será ditado assim que o destinatário atender."
}`,
      },
    ],
  },
  {
    label: 'Agentes',
    endpoints: [
      {
        method: 'GET', path: '/v1/agents', desc: 'Listar todos os agentes IA do tenant', scope: 'agents:read',
        response: `{
  "data": [
    { "id": "agt_abc123", "name": "Vendas PT", "language": "pt", "active": true }
  ],
  "total": 3
}`,
      },
      {
        method: 'GET', path: '/v1/agents/:id', desc: 'Detalhe completo de um agente IA', scope: 'agents:read',
        params: [{ name: 'id', type: 'string', required: true, desc: 'ID do agente' }],
        response: `{
  "id": "agt_abc123",
  "name": "Vendas PT",
  "language": "pt",
  "systemPrompt": "És um assistente de vendas...",
  "voiceId": "...",
  "active": true,
  "createdAt": "2026-01-10T09:00:00.000Z"
}`,
      },
    ],
  },
  {
    label: 'Contactos',
    endpoints: [
      {
        method: 'POST', path: '/v1/contacts', desc: 'Criar um novo contacto', scope: 'contacts:write',
        body: `{
  "name": "Maria Santos",      // obrigatório
  "phone": "+244912000001",    // obrigatório — E.164
  "email": "maria@exemplo.ao", // opcional
  "tags": ["cliente", "vip"],  // opcional
  "customFields": { "empresa": "ACME" } // opcional
}`,
        response: `{
  "id": "cnt_001",
  "name": "Maria Santos",
  "phone": "+244912000001",
  "createdAt": "2026-07-20T10:00:00.000Z"
}`,
      },
      {
        method: 'GET', path: '/v1/contacts', desc: 'Listar contactos com filtros', scope: 'contacts:read',
        params: [
          { name: 'search', type: 'string', desc: 'Pesquisa por nome, telefone ou email' },
          { name: 'tag', type: 'string', desc: 'Filtrar por tag' },
          { name: 'page', type: 'number', desc: 'Página (default 1)' },
          { name: 'limit', type: 'number', desc: 'Resultados por página (max 100)' },
        ],
        response: `{
  "data": [ { "id": "cnt_001", "name": "Maria Santos", "phone": "+244912000001" } ],
  "total": 87,
  "page": 1,
  "limit": 20
}`,
      },
      {
        method: 'GET', path: '/v1/contacts/:id', desc: 'Detalhe de um contacto', scope: 'contacts:read',
        params: [{ name: 'id', type: 'string', required: true, desc: 'ID do contacto' }],
        response: `{
  "id": "cnt_001",
  "name": "Maria Santos",
  "phone": "+244912000001",
  "email": "maria@exemplo.ao",
  "tags": ["cliente"],
  "totalCalls": 5,
  "lastCallAt": "2026-07-18T14:30:00.000Z"
}`,
      },
      {
        method: 'PATCH', path: '/v1/contacts/:id', desc: 'Actualizar campos de um contacto', scope: 'contacts:write',
        params: [{ name: 'id', type: 'string', required: true, desc: 'ID do contacto' }],
        body: `{
  "name": "Maria A. Santos",   // opcional
  "email": "novo@exemplo.ao",  // opcional
  "tags": ["cliente", "vip"]   // opcional — substitui todas as tags
}`,
        response: `{ "id": "cnt_001", "name": "Maria A. Santos", ... }`,
      },
      {
        method: 'DELETE', path: '/v1/contacts/:id', desc: 'Eliminar um contacto permanentemente', scope: 'contacts:write',
        params: [{ name: 'id', type: 'string', required: true, desc: 'ID do contacto' }],
        response: `{ "deleted": true }`,
      },
    ],
  },
  {
    label: 'Campanhas',
    endpoints: [
      {
        method: 'POST', path: '/v1/campaigns', desc: 'Criar uma nova campanha de chamadas automáticas', scope: 'campaigns:write',
        body: `{
  "name": "Recuperação Julho",  // obrigatório
  "agentId": "agt_abc123",      // obrigatório
  "contactIds": ["cnt_001"],    // obrigatório — lista de contactos
  "scheduledAt": "2026-07-25T09:00:00Z" // opcional
}`,
        response: `{
  "id": "cmp_001",
  "name": "Recuperação Julho",
  "status": "DRAFT",
  "totalContacts": 1,
  "createdAt": "2026-07-20T10:00:00.000Z"
}`,
      },
      {
        method: 'GET', path: '/v1/campaigns', desc: 'Listar campanhas do tenant', scope: 'campaigns:read',
        params: [
          { name: 'status', type: 'string', desc: 'Filtrar por status (DRAFT, RUNNING, FINISHED, …)' },
          { name: 'page', type: 'number', desc: 'Página (default 1)' },
        ],
        response: `{
  "data": [ { "id": "cmp_001", "name": "Recuperação Julho", "status": "RUNNING" } ],
  "total": 12
}`,
      },
      {
        method: 'GET', path: '/v1/campaigns/:id', desc: 'Detalhe e métricas de uma campanha', scope: 'campaigns:read',
        params: [{ name: 'id', type: 'string', required: true, desc: 'ID da campanha' }],
        response: `{
  "id": "cmp_001",
  "name": "Recuperação Julho",
  "status": "FINISHED",
  "totalContacts": 150,
  "completed": 132,
  "failed": 18,
  "conversionRate": 0.24
}`,
      },
    ],
  },
  {
    label: 'Carteira',
    endpoints: [
      {
        method: 'GET', path: '/v1/wallet', desc: 'Saldo actual e últimos movimentos', scope: 'wallet:read',
        response: `{
  "balance": 96767.03,
  "currency": "AOA",
  "transactions": [
    { "id": "txn_01", "type": "DEBIT", "amount": 150.00, "description": "Chamada #call_xyz789", "createdAt": "..." }
  ]
}`,
      },
    ],
  },
];

const WEBHOOK_EVENTS = [
  {
    event: 'call.completed',
    desc: 'Chamada terminada com sucesso',
    payload: `{
  "event": "call.completed",
  "callId": "call_xyz789",
  "to": "+244923000000",
  "agentId": "agt_abc123",
  "durationSeconds": 42,
  "result": "SALE",
  "sentiment": "POSITIVE",
  "transcript": "Olá, ligo da Falaí...",
  "timestamp": "2026-07-20T15:01:00.000Z"
}`,
  },
  {
    event: 'call.failed',
    desc: 'Falha técnica ao estabelecer ou manter a chamada',
    payload: `{
  "event": "call.failed",
  "callId": "call_xyz790",
  "to": "+244923000001",
  "reason": "provider_error",
  "timestamp": "2026-07-20T15:02:00.000Z"
}`,
  },
  {
    event: 'call.no_answer',
    desc: 'Destino não atendeu dentro do tempo limite',
    payload: `{
  "event": "call.no_answer",
  "callId": "call_xyz791",
  "to": "+244923000002",
  "timestamp": "2026-07-20T15:03:00.000Z"
}`,
  },
  {
    event: 'call.escalated',
    desc: 'Chamada transferida para agente humano',
    payload: `{
  "event": "call.escalated",
  "callId": "call_xyz792",
  "to": "+244923000003",
  "reason": "customer_request",
  "timestamp": "2026-07-20T15:04:00.000Z"
}`,
  },
  {
    event: 'campaign.finished',
    desc: 'Campanha concluiu todas as chamadas',
    payload: `{
  "event": "campaign.finished",
  "campaignId": "cmp_001",
  "name": "Recuperação Julho",
  "totalContacts": 150,
  "completed": 132,
  "failed": 18,
  "timestamp": "2026-07-20T18:00:00.000Z"
}`,
  },
  {
    event: 'wallet.low_balance',
    desc: 'Saldo abaixo do limiar configurado',
    payload: `{
  "event": "wallet.low_balance",
  "balance": 500.00,
  "currency": "AOA",
  "threshold": 1000.00,
  "timestamp": "2026-07-20T20:00:00.000Z"
}`,
  },
];

const ERROR_CODES = [
  { code: '400', title: 'Bad Request', desc: 'Payload inválido ou parâmetro em falta. Ver campo `error` na resposta.' },
  { code: '401', title: 'Unauthorized', desc: 'API key ausente, inválida ou revogada.' },
  { code: '403', title: 'Forbidden', desc: 'A chave não tem o scope necessário para esta operação.' },
  { code: '404', title: 'Not Found', desc: 'Recurso não encontrado ou não pertence ao tenant.' },
  { code: '422', title: 'Unprocessable', desc: 'Regra de negócio violada (ex: saldo insuficiente, plano incompatível).' },
  { code: '429', title: 'Rate Limit', desc: 'Demasiados pedidos. Aguarda e tenta novamente. Header `Retry-After` indica os segundos.' },
  { code: '502', title: 'Provider Error', desc: 'Falha no operador de telefonia. Tenta novamente após alguns segundos.' },
];

function CodeBlock({ code, language = 'json' }: { code: string; language?: string }) {
  const { success } = useToast();
  return (
    <div className="relative group">
      <div className="rounded-lg bg-gray-900 p-3 overflow-x-auto">
        <pre className={`text-xs ${language === 'bash' ? 'text-green-400' : 'text-blue-300'}`}>{code}</pre>
      </div>
      <button
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-gray-700 hover:bg-gray-600 text-gray-200 rounded p-1"
        onClick={() => { void navigator.clipboard.writeText(code); success('Copiado!'); }}
        title="Copiar"
      >
        <Copy className="h-3 w-3" />
      </button>
    </div>
  );
}

function EndpointRow({ ep, baseUrl }: { ep: EndpointDef; baseUrl: string }) {
  const [open, setOpen] = useState(false);

  const curlExample = ep.method === 'GET'
    ? `curl ${baseUrl}${ep.path.replace(':id', '<id>')}${ep.params?.filter(p => !p.required).length ? '?page=1&limit=20' : ''} \\
  -H "X-API-Key: fal_live_..."`
    : ep.method === 'DELETE'
    ? `curl -X DELETE ${baseUrl}${ep.path.replace(':id', '<id>')} \\
  -H "X-API-Key: fal_live_..."`
    : `curl -X ${ep.method} ${baseUrl}${ep.path.replace(':id', '<id>')} \\
  -H "X-API-Key: fal_live_..." \\
  -H "Content-Type: application/json" \\
  -d '${ep.body?.replace(/\s*\/\/.*$/gm, '').replace(/\n\s*\n/g, '\n').trim() ?? '{}'}'`;

  return (
    <div className="border-b border-gray-100 last:border-0">
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <Badge className={`${METHOD_COLOR[ep.method] ?? ''} w-14 justify-center text-xs flex-shrink-0`}>{ep.method}</Badge>
        <code className="text-xs text-gray-800 flex-1 font-mono">{ep.path}</code>
        <span className="text-xs text-gray-500 hidden sm:block flex-shrink-0">{ep.desc}</span>
        <code className="text-xs bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded flex-shrink-0">{ep.scope}</code>
        {open ? <ChevronDown className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 bg-gray-50 border-t border-gray-100">
          <p className="text-xs text-gray-600 pt-3">{ep.desc}</p>

          {ep.params && ep.params.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-1.5">
                {ep.method === 'GET' ? 'Query params' : 'Path params'}
              </p>
              <div className="rounded-lg border border-gray-200 overflow-hidden">
                {ep.params.map((p) => (
                  <div key={p.name} className="flex items-start gap-3 px-3 py-2 text-xs border-b border-gray-100 last:border-0 bg-white">
                    <code className="text-purple-700 font-mono flex-shrink-0 w-28">{p.name}</code>
                    <span className="text-gray-400 flex-shrink-0 w-14">{p.type}</span>
                    {p.required && <span className="text-red-500 flex-shrink-0">*</span>}
                    <span className="text-gray-600">{p.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {ep.body && (
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-1.5">Request body</p>
              <CodeBlock code={ep.body} language="json" />
            </div>
          )}

          <div>
            <p className="text-xs font-semibold text-gray-700 mb-1.5">Exemplo cURL</p>
            <CodeBlock code={curlExample} language="bash" />
          </div>

          <div>
            <p className="text-xs font-semibold text-gray-700 mb-1.5">Resposta (200/202)</p>
            <CodeBlock code={ep.response} language="json" />
          </div>
        </div>
      )}
    </div>
  );
}

function DocsPanel() {
  const [baseUrl, setBaseUrl] = useState('https://api.falai.ao');
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ 'Chamadas': true });
  const [openWebhook, setOpenWebhook] = useState<string | null>(null);

  function toggleGroup(label: string) {
    setOpenGroups((prev) => ({ ...prev, [label]: !prev[label] }));
  }

  return (
    <div className="space-y-4">
      {/* Base URL toggle */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900">Base URL</h3>
          <div className="flex gap-1 rounded-lg border border-gray-200 p-0.5 bg-gray-50">
            <button
              className={`text-xs px-3 py-1 rounded-md transition-colors ${baseUrl === 'https://api.falai.ao' ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-500 hover:text-gray-700'}`}
              onClick={() => setBaseUrl('https://api.falai.ao')}
            >
              Live
            </button>
            <button
              className={`text-xs px-3 py-1 rounded-md transition-colors ${baseUrl === 'http://localhost:3000' ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-500 hover:text-gray-700'}`}
              onClick={() => setBaseUrl('http://localhost:3000')}
            >
              Local
            </button>
          </div>
        </div>
        <CodeBlock code={baseUrl} language="bash" />
      </Card>

      {/* Autenticação */}
      <Card>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Autenticação</h3>
        <p className="text-xs text-gray-600 mb-3">
          Inclui a tua API key num destes headers em todos os pedidos:
        </p>
        <div className="flex gap-2 mb-3">
          <code className="text-xs bg-gray-100 px-2 py-1 rounded font-mono">Authorization: Bearer fal_live_…</code>
          <span className="text-xs text-gray-400">ou</span>
          <code className="text-xs bg-gray-100 px-2 py-1 rounded font-mono">X-API-Key: fal_live_…</code>
        </div>
        <CodeBlock
          language="bash"
          code={`curl ${baseUrl}/v1/calls \\
  -H "X-API-Key: fal_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"agt_abc123","to":"+244923000000"}'`}
        />
      </Card>

      {/* Endpoints agrupados */}
      <div className="rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="text-sm font-semibold text-gray-900">Endpoints</h3>
          <p className="text-xs text-gray-500 mt-0.5">Clica num endpoint para ver parâmetros, exemplos e resposta</p>
        </div>
        {ENDPOINT_GROUPS.map((group) => (
          <div key={group.label} className="border-b border-gray-200 last:border-0">
            <button
              className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition-colors"
              onClick={() => toggleGroup(group.label)}
            >
              <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">{group.label}</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">{group.endpoints.length} endpoint{group.endpoints.length !== 1 ? 's' : ''}</span>
                {openGroups[group.label] ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
              </div>
            </button>
            {openGroups[group.label] && (
              <div className="bg-white">
                {group.endpoints.map((ep) => (
                  <EndpointRow key={`${ep.method}-${ep.path}`} ep={ep} baseUrl={baseUrl} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Webhooks */}
      <div className="rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="text-sm font-semibold text-gray-900">Webhooks emitidos</h3>
          <p className="text-xs text-gray-500 mt-0.5">Clica num evento para ver o payload. Configura a URL em <strong>Definições → Integrações</strong>.</p>
        </div>
        {WEBHOOK_EVENTS.map((w) => (
          <div key={w.event} className="border-b border-gray-100 last:border-0">
            <button
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition-colors text-left"
              onClick={() => setOpenWebhook(openWebhook === w.event ? null : w.event)}
            >
              <code className="text-xs bg-gray-100 text-gray-800 px-2 py-0.5 rounded font-mono flex-shrink-0">{w.event}</code>
              <span className="text-xs text-gray-500 flex-1">{w.desc}</span>
              {openWebhook === w.event ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
            </button>
            {openWebhook === w.event && (
              <div className="px-4 pb-4 bg-gray-50 border-t border-gray-100">
                <p className="text-xs text-gray-600 py-2">Payload entregue via HTTP POST à tua URL de webhook:</p>
                <CodeBlock code={w.payload} language="json" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Erros */}
      <Card padding={false}>
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-gray-500" />
            <h3 className="text-sm font-semibold text-gray-900">Códigos de erro</h3>
          </div>
        </div>
        <div className="divide-y divide-gray-100">
          {ERROR_CODES.map((e) => (
            <div key={e.code} className="flex items-start gap-3 px-4 py-2.5">
              <span className={`text-xs font-mono font-bold flex-shrink-0 w-8 mt-0.5 ${
                e.code.startsWith('4') ? 'text-amber-600' : 'text-red-600'
              }`}>{e.code}</span>
              <div>
                <p className="text-xs font-medium text-gray-900">{e.title}</p>
                <p className="text-xs text-gray-500 mt-0.5">{e.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function DevelopersPage() {
  const [tab, setTab] = useState('keys');

  return (
    <>
      <Header title="Developers" />

      <div className="p-6 max-w-3xl space-y-4">
        <Tabs
          tabs={[
            { key: 'keys', label: 'API Keys' },
            { key: 'webhooks', label: 'Webhooks' },
            { key: 'docs', label: 'Documentação' },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === 'keys' && <ApiKeysList />}
        {tab === 'webhooks' && <WebhookPanel />}
        {tab === 'docs' && <DocsPanel />}
      </div>
    </>
  );
}
