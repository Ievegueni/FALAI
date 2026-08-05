import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, CheckCircle, DollarSign, Phone, RefreshCw, Plus, Trash2, PhoneCall, Star, KeyRound, UserPlus, Users, Shield } from 'lucide-react';
import { tenantsApi, plansApi } from '@/lib/api';
import {
  Card, Button, Badge, Tabs, PageSpinner, Modal, Input, Select,
  EmptyState, Pagination,
} from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';
import {
  formatAOA, formatDate, formatDuration,
  tenantStatusColor, tenantStatusLabel,
  callStatusColor, callStatusLabel, txTypeLabel,
} from '@/lib/utils';
import type { TenantStatus, CallStatus, TransactionType, TenantLine, TenantLineInput, TenantUser, TenantRole, BillingMode, FeatureKey, TenantFeatures } from '@/types';

const ROLE_LABELS: Record<TenantRole, string> = {
  OWNER: 'Proprietário',
  ADMIN: 'Administrador',
  MEMBER: 'Membro',
  VIEWER: 'Leitura',
};

const BILLING_LABELS: Record<BillingMode, string> = {
  PER_MINUTE: 'Por minuto',
  PER_SECOND: 'Por segundo',
  PER_CALL: 'Por chamada',
};

const FEATURE_LABELS: { key: FeatureKey; label: string; hint?: string; needsAi?: boolean }[] = [
  { key: 'agents', label: 'Agentes de IA', hint: 'Criar e gerir agentes conversacionais', needsAi: true },
  { key: 'campaigns', label: 'Campanhas', hint: 'Campanhas de chamadas automáticas', needsAi: true },
  { key: 'contacts', label: 'Contactos', hint: 'Gestão da base de contactos' },
  { key: 'calls', label: 'Histórico de chamadas', hint: 'Ver registo e detalhe de chamadas' },
  { key: 'directCall', label: 'Chamada directa', hint: 'Click-to-call de uma extensão para um número' },
  { key: 'otpCall', label: 'OTP por voz', hint: 'Entrega de códigos OTP por chamada' },
  { key: 'webphone', label: 'Webphone', hint: 'Telefone no browser (WebRTC) — atende e liga sem hardphone' },
  { key: 'wallet', label: 'Carteira', hint: 'Saldo e movimentos' },
  { key: 'team', label: 'Equipa', hint: 'Gestão de utilizadores do cliente' },
  { key: 'developers', label: 'Developers / API', hint: 'API keys, webhooks e documentação' },
];

function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
        disabled ? 'bg-gray-200 cursor-not-allowed' : checked ? 'bg-indigo-600' : 'bg-gray-300'
      }`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

export function TenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [callPage, setCallPage] = useState(1);
  const [txPage, setTxPage] = useState(1);
  const [adjustModal, setAdjustModal] = useState(false);
  const [adjustAmt, setAdjustAmt] = useState('');
  const [adjustNote, setAdjustNote] = useState('');
  const [planModal, setPlanModal] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [lineModal, setLineModal] = useState(false);
  const [editingLine, setEditingLine] = useState<TenantLine | null>(null);
  const [lineForm, setLineForm] = useState<TenantLineInput>({ name: '', extension: '', phoneNumber: '' });
  const [featuresDraft, setFeaturesDraft] = useState<TenantFeatures | null>(null);
  const [resetUser, setResetUser] = useState<TenantUser | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [userModal, setUserModal] = useState(false);
  const [userForm, setUserForm] = useState<{ name: string; email: string; password: string; role: TenantRole }>({ name: '', email: '', password: '', role: 'MEMBER' });

  const { data: tenant, isLoading, isError } = useQuery({
    queryKey: ['admin', 'tenant', id],
    queryFn: () => tenantsApi.get(id!),
    enabled: !!id,
    retry: false,
  });

  // Sincroniza o rascunho de funcionalidades quando o tenant carrega
  useEffect(() => {
    if (tenant?.features) setFeaturesDraft(tenant.features);
  }, [tenant?.features]);

  const { data: plans } = useQuery({
    queryKey: ['admin', 'plans'],
    queryFn: () => plansApi.list(),
    enabled: planModal,
  });

  const { data: calls } = useQuery({
    queryKey: ['admin', 'tenant-calls', id, callPage],
    queryFn: () => tenantsApi.calls(id!, { page: callPage, perPage: 10 }),
    enabled: tab === 'calls' && !!id,
  });

  const { data: txs } = useQuery({
    queryKey: ['admin', 'tenant-txs', id, txPage],
    queryFn: () => tenantsApi.transactions(id!, { page: txPage, perPage: 10 }),
    enabled: tab === 'wallet' && !!id,
  });

  const invalidateTenant = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'tenant', id] });
    void qc.invalidateQueries({ queryKey: ['admin', 'tenants'] });
  };

  const suspendMut = useMutation({
    mutationFn: () => tenantsApi.suspend(id!),
    onSuccess: () => { invalidateTenant(); toast.success('Tenant suspenso.'); },
    onError: (e: Error) => toast.error(e.message || 'Erro ao suspender.'),
  });

  const reactivateMut = useMutation({
    mutationFn: () => tenantsApi.reactivate(id!),
    onSuccess: () => { invalidateTenant(); toast.success('Cliente activado.'); },
    onError: (e: Error) => toast.error(e.message || 'Erro ao activar cliente.'),
  });

  const changePlanMut = useMutation({
    mutationFn: () => tenantsApi.update(id!, { planId: selectedPlanId } as never),
    onSuccess: () => {
      invalidateTenant();
      toast.success('Plano actualizado.');
      setPlanModal(false);
      setSelectedPlanId('');
    },
    onError: () => toast.error('Erro ao trocar plano.'),
  });

  const adjustMut = useMutation({
    mutationFn: () => tenantsApi.adjustBalance(id!, { amountCents: Math.round(parseFloat(adjustAmt) * 100), note: adjustNote }),
    onSuccess: () => {
      invalidateTenant();
      toast.success('Saldo ajustado.');
      setAdjustModal(false);
      setAdjustAmt('');
      setAdjustNote('');
    },
  });

  const saveLineMut = useMutation({
    mutationFn: () =>
      editingLine
        ? tenantsApi.updateLine(id!, editingLine.id, {
            name: lineForm.name,
            extension: lineForm.extension,
            phoneNumber: lineForm.phoneNumber || undefined,
          })
        : tenantsApi.createLine(id!, {
            name: lineForm.name,
            extension: lineForm.extension,
            ...(lineForm.phoneNumber ? { phoneNumber: lineForm.phoneNumber } : {}),
          }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant', id] });
      toast.success(editingLine ? 'Linha actualizada.' : 'Linha criada.');
      setLineModal(false);
      setEditingLine(null);
      setLineForm({ name: '', extension: '', phoneNumber: '' });
    },
    onError: () => toast.error('Erro ao gravar linha.'),
  });

  const toggleLineMut = useMutation({
    mutationFn: (v: { lineId: string; data: Partial<TenantLineInput> }) => tenantsApi.updateLine(id!, v.lineId, v.data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'tenant', id] }); },
    onError: () => toast.error('Erro ao actualizar linha.'),
  });

  const deleteLineMut = useMutation({
    mutationFn: (lineId: string) => tenantsApi.deleteLine(id!, lineId),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'tenant', id] }); toast.success('Linha removida.'); },
    onError: () => toast.error('Erro ao remover linha.'),
  });

  const saveFeaturesMut = useMutation({
    mutationFn: () => tenantsApi.updateFeatures(id!, featuresDraft ?? {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'tenant', id] }); toast.success('Funcionalidades actualizadas.'); },
    onError: () => toast.error('Erro ao gravar funcionalidades.'),
  });

  const resetPwMut = useMutation({
    mutationFn: () => tenantsApi.resetUserPassword(id!, resetUser!.id, newPassword),
    onSuccess: () => {
      toast.success('Password redefinida. Comunica a nova password ao cliente.');
      setResetUser(null);
      setNewPassword('');
    },
    onError: (e: Error) => toast.error(e.message || 'Erro ao redefinir password.'),
  });

  const createUserMut = useMutation({
    mutationFn: () => tenantsApi.createUser(id!, userForm),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant', id] });
      toast.success('Utilizador criado.');
      setUserModal(false);
      setUserForm({ name: '', email: '', password: '', role: 'MEMBER' });
    },
    onError: (e: Error) => toast.error(e.message || 'Erro ao criar utilizador.'),
  });

  const billingOverrideMut = useMutation({
    mutationFn: (mode: BillingMode | null) => tenantsApi.update(id!, { billingModeOverride: mode } as never),
    onSuccess: () => { invalidateTenant(); toast.success('Modo de cobrança do cliente actualizado.'); },
    onError: (e: Error) => toast.error(e.message || 'Erro ao actualizar cobrança.'),
  });

  if (isLoading) return <PageSpinner />;

  if (isError || !tenant) {
    return (
      <div className="p-6">
        <Button variant="ghost" size="sm" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => navigate('/tenants')}>
          Voltar
        </Button>
        <EmptyState
          icon={<Ban className="h-8 w-8" />}
          title="Tenant não encontrado"
          description="O cliente que procuras não existe ou foi removido."
        />
      </div>
    );
  }

  const isInactive = tenant.status !== 'ACTIVE';

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => navigate('/tenants')}>
          Voltar
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-gray-900">{tenant.name}</h1>
            <Badge className={tenantStatusColor[tenant.status as TenantStatus]}>
              {tenantStatusLabel[tenant.status as TenantStatus] ?? tenant.status}
            </Badge>
          </div>
          <p className="text-sm text-gray-500">ID: {tenant.id}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" icon={<RefreshCw className="h-4 w-4" />} onClick={() => { setSelectedPlanId(tenant.planId ?? ''); setPlanModal(true); }}>
            Trocar plano
          </Button>
          <Button variant="outline" size="sm" icon={<DollarSign className="h-4 w-4" />} onClick={() => setAdjustModal(true)}>
            Ajustar saldo
          </Button>
          {isInactive ? (
            <Button size="sm" icon={<CheckCircle className="h-4 w-4" />} onClick={() => reactivateMut.mutate()} loading={reactivateMut.isPending}>
              Activar
            </Button>
          ) : (
            <Button variant="danger" size="sm" icon={<Ban className="h-4 w-4" />} onClick={() => suspendMut.mutate()} loading={suspendMut.isPending}>
              Suspender
            </Button>
          )}
        </div>
      </div>

      <Tabs
        tabs={[
          { key: 'overview', label: 'Visão geral' },
          { key: 'users', label: 'Utilizadores' },
          { key: 'lines', label: 'Linhas' },
          { key: 'features', label: 'Funcionalidades' },
          { key: 'sms', label: 'SMS' },
          { key: 'calls', label: 'Chamadas' },
          { key: 'wallet', label: 'Carteira' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'sms' && <SmsConfigTab tenantId={id!} />}

      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Card>
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Organização</h2>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between gap-4"><dt className="text-gray-500">Email</dt><dd className="font-medium text-right break-all">{tenant.email}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-gray-500">Telefone</dt><dd className="font-medium">{tenant.phone}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-gray-500">NIF</dt><dd className="font-medium">{tenant.nif ?? '–'}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-gray-500">Criado em</dt><dd className="font-medium">{formatDate(tenant.createdAt)}</dd></div>
            </dl>
          </Card>
          <Card>
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Conta & faturação</h2>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between"><dt className="text-gray-500">Plano</dt><dd className="font-medium">{tenant.plan?.name ?? '–'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Saldo</dt><dd className="font-medium">{formatAOA(tenant.balanceCents)}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Limite crédito</dt><dd className="font-medium">{formatAOA(tenant.creditLimitCents)}</dd></div>
              <div className="flex justify-between items-center gap-4">
                <dt className="text-gray-500">Cobrança</dt>
                <dd>
                  <Select
                    value={tenant.billingModeOverride ?? ''}
                    onChange={(e) => billingOverrideMut.mutate(e.target.value === '' ? null : (e.target.value as BillingMode))}
                    disabled={billingOverrideMut.isPending}
                  >
                    <option value="">Usar plano{tenant.plan ? ` (${BILLING_LABELS[tenant.plan.billingMode]})` : ''}</option>
                    <option value="PER_MINUTE">Por minuto</option>
                    <option value="PER_SECOND">Por segundo</option>
                    <option value="PER_CALL">Por chamada</option>
                  </Select>
                </dd>
              </div>
              <div className="flex justify-between"><dt className="text-gray-500">Webhook URL</dt><dd className="font-medium text-right max-w-[200px] truncate">{tenant.webhookUrl ?? '–'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Onboarding</dt><dd className="font-medium">{tenant.onboardingCompletedAt ? formatDate(tenant.onboardingCompletedAt) : 'Pendente'}</dd></div>
            </dl>
          </Card>
        </div>
      )}

      {tab === 'users' && (
        <Card padding={false}>
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <div>
              <h2 className="text-sm font-semibold text-gray-700">Utilizadores do cliente</h2>
              <p className="text-xs text-gray-500 mt-0.5">Contas de acesso ao CRM. As passwords são encriptadas — só podes redefini-las.</p>
            </div>
            <Button
              size="sm"
              icon={<UserPlus className="h-4 w-4" />}
              onClick={() => { setUserForm({ name: '', email: '', password: '', role: 'MEMBER' }); setUserModal(true); }}
            >
              Novo utilizador
            </Button>
          </div>
          {(tenant.users ?? []).length === 0 ? (
            <EmptyState icon={<Users className="h-8 w-8" />} title="Sem utilizadores" description="Este cliente ainda não tem contas de acesso." />
          ) : (
            <div className="divide-y divide-gray-100">
              {(tenant.users ?? []).map((u) => (
                <div key={u.id} className="flex items-center gap-4 px-6 py-3">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 text-sm font-semibold">
                    {u.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 truncate">{u.name}</span>
                      <Badge className="bg-gray-100 text-gray-600">{ROLE_LABELS[u.role] ?? u.role}</Badge>
                      {u.twoFaEnabled && (
                        <span className="inline-flex items-center gap-1 text-xs text-green-600"><Shield className="h-3 w-3" />2FA</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 truncate">{u.email}</div>
                  </div>
                  <div className="text-right text-xs text-gray-400 hidden sm:block">
                    {u.lastLoginAt ? `Último acesso ${formatDate(u.lastLoginAt)}` : 'Nunca acedeu'}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<KeyRound className="h-4 w-4" />}
                    onClick={() => { setResetUser(u); setNewPassword(''); }}
                  >
                    Redefinir password
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'lines' && (
        <Card padding={false}>
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <div>
              <h2 className="text-sm font-semibold text-gray-700">Linhas de chamadas</h2>
              <p className="text-xs text-gray-500 mt-0.5">Cada linha é uma extensão/DID que o cliente pode usar para chamadas.</p>
            </div>
            <Button
              size="sm"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => { setEditingLine(null); setLineForm({ name: '', extension: '', phoneNumber: '' }); setLineModal(true); }}
            >
              Nova linha
            </Button>
          </div>
          {(tenant.lines ?? []).length === 0 ? (
            <EmptyState icon={<PhoneCall className="h-8 w-8" />} title="Sem linhas" description="Cria a primeira linha deste cliente." />
          ) : (
            <div className="divide-y divide-gray-100">
              {(tenant.lines ?? []).map((line) => (
                <div key={line.id} className="flex items-center gap-4 px-6 py-3">
                  <PhoneCall className={`h-4 w-4 flex-shrink-0 ${line.isActive ? 'text-indigo-500' : 'text-gray-300'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <button
                        className="text-sm font-medium text-gray-900 hover:text-indigo-600"
                        onClick={() => { setEditingLine(line); setLineForm({ name: line.name, extension: line.extension, phoneNumber: line.phoneNumber ?? '' }); setLineModal(true); }}
                      >
                        {line.name}
                      </button>
                      {line.isDefault && (
                        <Badge className="bg-amber-100 text-amber-700 text-xs inline-flex items-center gap-1">
                          <Star className="h-3 w-3" /> Padrão
                        </Badge>
                      )}
                      {!line.isActive && <Badge className="bg-gray-100 text-gray-500 text-xs">Inactiva</Badge>}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Ext. <code className="bg-gray-100 px-1 rounded">{line.extension}</code>
                      {line.phoneNumber && <> · DID <code className="bg-gray-100 px-1 rounded">{line.phoneNumber}</code></>}
                    </p>
                  </div>
                  {!line.isDefault && line.isActive && (
                    <Button
                      size="sm" variant="ghost"
                      onClick={() => toggleLineMut.mutate({ lineId: line.id, data: { isDefault: true } })}
                    >
                      Tornar padrão
                    </Button>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">{line.isActive ? 'Activa' : 'Inactiva'}</span>
                    <Toggle
                      checked={line.isActive}
                      onChange={(v) => toggleLineMut.mutate({ lineId: line.id, data: { isActive: v } })}
                    />
                  </div>
                  <Button
                    size="sm" variant="ghost"
                    icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
                    onClick={() => { if (confirm(`Remover a linha "${line.name}"?`)) deleteLineMut.mutate(line.id); }}
                  />
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'features' && featuresDraft && (
        <Card>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-700">Funcionalidades do painel</h2>
              <p className="text-xs text-gray-500 mt-0.5">Controla o que este cliente vê e pode fazer no CRM.</p>
            </div>
            <Button
              size="sm"
              loading={saveFeaturesMut.isPending}
              disabled={JSON.stringify(featuresDraft) === JSON.stringify(tenant.features)}
              onClick={() => saveFeaturesMut.mutate()}
            >
              Guardar
            </Button>
          </div>
          <div className="divide-y divide-gray-100">
            {FEATURE_LABELS.map((f) => {
              const blockedByPlan = f.needsAi && tenant.plan?.aiAgentsEnabled === false;
              return (
                <div key={f.key} className="flex items-center justify-between py-3">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{f.label}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {blockedByPlan ? 'Indisponível — o plano deste cliente não inclui IA.' : f.hint}
                    </p>
                  </div>
                  <Toggle
                    checked={blockedByPlan ? false : featuresDraft[f.key]}
                    disabled={blockedByPlan}
                    onChange={(v) => setFeaturesDraft((prev) => (prev ? { ...prev, [f.key]: v } : prev))}
                  />
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {tab === 'calls' && (
        <Card padding={false}>
          {(calls?.data ?? []).length === 0 ? (
            <EmptyState icon={<Phone className="h-8 w-8" />} title="Sem chamadas" />
          ) : (
            <>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                  <tr>
                    {['Destino', 'Status', 'Duração', 'Custo', 'Data'].map((h) => (
                      <th key={h} className="px-6 py-3 text-left font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(calls?.data ?? []).map((c) => (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="px-6 py-3 font-medium text-gray-900">{c.to}</td>
                      <td className="px-6 py-3">
                        <Badge className={callStatusColor[c.status as CallStatus]}>
                          {callStatusLabel[c.status as CallStatus] ?? c.status}
                        </Badge>
                      </td>
                      <td className="px-6 py-3 text-gray-600">{c.durationSecs !== undefined ? formatDuration(c.durationSecs) : '–'}</td>
                      <td className="px-6 py-3 text-gray-600">{c.costCents !== undefined ? formatAOA(c.costCents) : '–'}</td>
                      <td className="px-6 py-3 text-gray-500">{formatDate(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination page={callPage} total={calls?.total ?? 0} perPage={10} onPage={setCallPage} />
            </>
          )}
        </Card>
      )}

      {tab === 'wallet' && (
        <Card padding={false}>
          {(txs?.data ?? []).length === 0 ? (
            <EmptyState icon={<DollarSign className="h-8 w-8" />} title="Sem transacções" />
          ) : (
            <>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                  <tr>
                    {['Tipo', 'Valor', 'Saldo após', 'Notas', 'Data'].map((h) => (
                      <th key={h} className="px-6 py-3 text-left font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(txs?.data ?? []).map((t) => (
                    <tr key={t.id} className="hover:bg-gray-50">
                      <td className="px-6 py-3 text-gray-700">{txTypeLabel[t.type as TransactionType] ?? t.type}</td>
                      <td className={`px-6 py-3 font-medium ${t.amountCents > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {t.amountCents > 0 ? '+' : ''}{formatAOA(t.amountCents)}
                      </td>
                      <td className="px-6 py-3 text-gray-600">{formatAOA(t.balanceAfterCents)}</td>
                      <td className="px-6 py-3 text-gray-500 max-w-[200px] truncate">{t.notes ?? '–'}</td>
                      <td className="px-6 py-3 text-gray-500">{formatDate(t.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination page={txPage} total={txs?.total ?? 0} perPage={10} onPage={setTxPage} />
            </>
          )}
        </Card>
      )}

      <Modal
        open={planModal}
        onClose={() => setPlanModal(false)}
        title="Trocar plano"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setPlanModal(false)}>Cancelar</Button>
            <Button
              loading={changePlanMut.isPending}
              disabled={!selectedPlanId || selectedPlanId === tenant.planId}
              onClick={() => changePlanMut.mutate()}
            >
              Confirmar
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-500">
            Plano actual: <strong className="text-gray-800">{tenant.plan?.name ?? '–'}</strong>
          </p>
          <div className="space-y-2">
            {(plans ?? []).map((p) => (
              <label
                key={p.id}
                className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${
                  selectedPlanId === p.id
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="radio"
                    name="plan"
                    value={p.id}
                    checked={selectedPlanId === p.id}
                    onChange={() => setSelectedPlanId(p.id)}
                    className="accent-blue-600"
                  />
                  <div>
                    <p className="text-sm font-medium text-gray-900">{p.name}</p>
                    <p className="text-xs text-gray-500">{p.productType === 'VOICE_AI' ? 'Voice AI' : 'CRM BYO-PBX'}</p>
                  </div>
                </div>
                <span className="text-sm text-gray-600">
                  {p.monthlyFeeCents > 0 ? `${(p.monthlyFeeCents / 100).toFixed(2)} Kz/mês` : `${(p.pricePerMinCents / 100).toFixed(2)} Kz/min`}
                </span>
              </label>
            ))}
          </div>
        </div>
      </Modal>

      <Modal
        open={lineModal}
        onClose={() => setLineModal(false)}
        title={editingLine ? 'Editar linha' : 'Nova linha'}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setLineModal(false)}>Cancelar</Button>
            <Button
              loading={saveLineMut.isPending}
              disabled={!lineForm.name.trim() || !lineForm.extension.trim()}
              onClick={() => saveLineMut.mutate()}
            >
              {editingLine ? 'Guardar' : 'Criar'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Nome da linha"
            placeholder="ex: Vendas, Suporte"
            value={lineForm.name}
            onChange={(e) => setLineForm((f) => ({ ...f, name: e.target.value }))}
          />
          <Input
            label="Extensão"
            placeholder="ex: 1001"
            value={lineForm.extension}
            onChange={(e) => setLineForm((f) => ({ ...f, extension: e.target.value }))}
            hint="Extensão de origem no PBX"
          />
          <Input
            label="Número / DID (opcional)"
            placeholder="ex: +244923000000"
            value={lineForm.phoneNumber ?? ''}
            onChange={(e) => setLineForm((f) => ({ ...f, phoneNumber: e.target.value }))}
          />
        </div>
      </Modal>

      <Modal
        open={adjustModal}
        onClose={() => setAdjustModal(false)}
        title="Ajustar saldo"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setAdjustModal(false)}>Cancelar</Button>
            <Button loading={adjustMut.isPending} onClick={() => adjustMut.mutate()}>Confirmar</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Valor (Kz)"
            type="number"
            placeholder="ex: 5000 ou -2000"
            value={adjustAmt}
            onChange={(e) => setAdjustAmt(e.target.value)}
            hint="Use valor negativo para débito"
          />
          <Input
            label="Nota interna"
            placeholder="Motivo do ajuste…"
            value={adjustNote}
            onChange={(e) => setAdjustNote(e.target.value)}
          />
        </div>
      </Modal>

      {/* Redefinir password de um utilizador */}
      <Modal
        open={!!resetUser}
        onClose={() => { setResetUser(null); setNewPassword(''); }}
        title="Redefinir password"
        footer={
          <>
            <Button variant="outline" onClick={() => { setResetUser(null); setNewPassword(''); }}>Cancelar</Button>
            <Button
              loading={resetPwMut.isPending}
              disabled={newPassword.length < 8}
              onClick={() => resetPwMut.mutate()}
            >
              Definir password
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Vais definir uma nova password para <strong>{resetUser?.name}</strong> ({resetUser?.email}).
            A password antiga deixa de funcionar. Comunica a nova password ao cliente por um canal seguro.
          </p>
          <Input
            label="Nova password"
            type="text"
            placeholder="mínimo 8 caracteres"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            hint="Mostrada em texto para poderes copiá-la e enviar ao cliente."
          />
        </div>
      </Modal>

      {/* Criar novo utilizador */}
      <Modal
        open={userModal}
        onClose={() => setUserModal(false)}
        title="Novo utilizador"
        footer={
          <>
            <Button variant="outline" onClick={() => setUserModal(false)}>Cancelar</Button>
            <Button
              loading={createUserMut.isPending}
              disabled={userForm.name.trim().length < 2 || !/.+@.+\..+/.test(userForm.email) || userForm.password.length < 8}
              onClick={() => createUserMut.mutate()}
            >
              Criar utilizador
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input label="Nome" placeholder="ex: João Silva" value={userForm.name} onChange={(e) => setUserForm((f) => ({ ...f, name: e.target.value }))} />
          <Input label="Email de acesso" type="email" placeholder="joao@empresa.ao" value={userForm.email} onChange={(e) => setUserForm((f) => ({ ...f, email: e.target.value }))} />
          <Input label="Password" type="text" placeholder="mínimo 8 caracteres" value={userForm.password} onChange={(e) => setUserForm((f) => ({ ...f, password: e.target.value }))} />
          <Select label="Função" value={userForm.role} onChange={(e) => setUserForm((f) => ({ ...f, role: e.target.value as TenantRole }))}>
            <option value="OWNER">Proprietário</option>
            <option value="ADMIN">Administrador</option>
            <option value="MEMBER">Membro</option>
            <option value="VIEWER">Leitura</option>
          </Select>
        </div>
      </Modal>
    </div>
  );
}

// ─── Configuração de SMS (gateway Futurix, por cliente) ──────────────────────
function SmsConfigTab({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['tenant-sms', tenantId],
    queryFn: () => tenantsApi.smsConfig(tenantId),
  });

  const [apiKey, setApiKey] = useState('');
  const [senderId, setSenderId] = useState('');
  const [price, setPrice] = useState('');

  useEffect(() => {
    if (data) {
      setSenderId(data.senderId ?? '');
      setPrice(data.priceSegmentCents != null ? String(data.priceSegmentCents) : '');
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      tenantsApi.saveSmsConfig(tenantId, {
        ...(apiKey ? { apiKey } : {}),
        senderId,
        ...(price !== '' ? { priceSegmentCents: parseInt(price, 10) } : {}),
      }),
    onSuccess: () => {
      toast.success('Configuração de SMS guardada');
      setApiKey('');
      void qc.invalidateQueries({ queryKey: ['tenant-sms', tenantId] });
    },
    onError: () => toast.error('Erro ao guardar'),
  });

  if (isLoading || !data) return <PageSpinner />;

  return (
    <Card className="max-w-xl space-y-4">
      {!data.enabled && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          O plano deste cliente não tem SMS activado. Active-o no plano para o cliente poder enviar.
        </div>
      )}
      <div>
        <label className="text-sm font-medium text-gray-700">API Key Futurix</label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={data.apiKeySet ? '•••••••• (definida — deixe vazio para manter)' : 'Cole a API key da Futurix'}
        />
      </div>
      <Input label="Sender ID" value={senderId} onChange={(e) => setSenderId(e.target.value)} placeholder="ex.: COMUNICA" />
      <div>
        <Input
          label="Preço por segmento (cêntimos)"
          type="number"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder={`Default do plano: ${data.planPriceSegmentCents}`}
        />
        <p className="mt-1 text-xs text-gray-400">Vazio = usa o preço do plano. Definido pela Futurix.</p>
      </div>
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
        <p className="font-medium text-gray-700">Delivery report</p>
        <p className="mt-0.5">
          Nas Definições da conta Futurix deste cliente, define o <code>webhook_url</code> para o endpoint
          {' '}
          <code className="rounded bg-gray-200 px-1 py-0.5">https://&lt;dominio-da-api&gt;/webhooks/sms</code>
          {' '}— actualiza o estado das mensagens (Entregue/Falhou) automaticamente.
        </p>
      </div>
      <Button onClick={() => save.mutate()} disabled={save.isPending}>Guardar</Button>
    </Card>
  );
}
