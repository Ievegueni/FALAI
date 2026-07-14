import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Copy, Trash2, Code2, Webhook, Key, CheckCircle, Play } from 'lucide-react';
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
  { key: 'contacts:write', label: 'Criar contactos' },
  { key: 'contacts:read', label: 'Ler contactos' },
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

function DocsPanel() {
  const endpoints = [
    { method: 'POST', path: '/v1/calls', desc: 'Iniciar uma chamada' },
    { method: 'GET', path: '/v1/calls/:id', desc: 'Estado, transcript e resultado' },
    { method: 'GET', path: '/v1/calls', desc: 'Listar chamadas com filtros' },
    { method: 'GET', path: '/v1/agents', desc: 'Listar agentes' },
    { method: 'POST', path: '/v1/contacts', desc: 'Criar contacto' },
    { method: 'GET', path: '/v1/contacts', desc: 'Listar contactos' },
    { method: 'GET', path: '/v1/wallet', desc: 'Saldo e últimos movimentos' },
  ];

  const methodColor: Record<string, string> = {
    GET: 'bg-blue-100 text-blue-700',
    POST: 'bg-emerald-100 text-emerald-700',
    DELETE: 'bg-red-100 text-red-700',
    PATCH: 'bg-amber-100 text-amber-700',
  };

  return (
    <div className="space-y-4">
      <Card>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Autenticação</h3>
        <p className="text-xs text-gray-600 mb-3">Use o header <code className="bg-gray-100 px-1 rounded">Authorization: Bearer fal_live_…</code> ou <code className="bg-gray-100 px-1 rounded">X-API-Key: fal_live_…</code></p>
        <div className="rounded-lg bg-gray-900 p-3">
          <pre className="text-xs text-green-400 overflow-x-auto">{`curl https://api.falai.ao/v1/calls \\
  -H "Authorization: Bearer fal_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"...","to":"+244923000000"}'`}</pre>
        </div>
      </Card>

      <Card padding={false}>
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-900">Endpoints</h3>
        </div>
        <div className="divide-y divide-gray-100">
          {endpoints.map((e) => (
            <div key={`${e.method}-${e.path}`} className="flex items-center gap-3 px-4 py-2.5">
              <Badge className={`${methodColor[e.method] ?? ''} w-12 justify-center text-xs`}>{e.method}</Badge>
              <code className="text-xs text-gray-800 flex-1">{e.path}</code>
              <span className="text-xs text-gray-500">{e.desc}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Webhooks emitidos</h3>
        <div className="space-y-1 text-xs text-gray-600">
          {['call.completed', 'call.failed', 'call.no_answer', 'call.escalated', 'campaign.finished', 'wallet.low_balance'].map((e) => (
            <p key={e}><code className="bg-gray-100 px-1 rounded">{e}</code></p>
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
