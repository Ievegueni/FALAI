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
import { TenantIvrTab } from './TenantIvrTab';
import { TenantExtensionsTab } from './TenantExtensionsTab';
import { TenantAccessProfilesTab } from './TenantAccessProfilesTab';
import {
  formatAOA, formatDate, formatDuration,
  tenantStatusColor, tenantStatusLabel,
  callStatusColor, callStatusLabel, txTypeLabel,
  campaignStatusColor, campaignStatusLabel,
} from '@/lib/utils';
import type { TenantStatus, CallStatus, CampaignStatus, TransactionType, TenantLine, TenantLineInput, TenantUser, TenantRole, BillingMode, FeatureKey, TenantFeatures, WaPoolStatus } from '@/types';

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
  { key: 'reports', label: 'Relatórios', hint: 'Relatórios de chamadas (CSV/PDF)' },
  { key: 'sms', label: 'SMS', hint: 'Envio de SMS avulso e campanhas (o plano tem de incluir SMS)' },
  { key: 'telephony', label: 'Telefonia', hint: 'Extensões, grupos, trunks e rotas' },
  { key: 'inbox', label: 'Caixa de entrada', hint: 'WhatsApp Business, chat no site, email e Telegram com IA e operadores' },
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
  const [campaignPage, setCampaignPage] = useState(1);
  const [openCampaignId, setOpenCampaignId] = useState<string | null>(null);
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
  const [userForm, setUserForm] = useState<{ name: string; email: string; password: string; role: TenantRole; accessProfileId: string }>({ name: '', email: '', password: '', role: 'MEMBER', accessProfileId: '' });

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

  const { data: campaigns } = useQuery({
    queryKey: ['admin', 'tenant-campaigns', id, campaignPage],
    queryFn: () => tenantsApi.campaigns(id!, { page: campaignPage, perPage: 10 }),
    enabled: tab === 'campaigns' && !!id,
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

  // O que o plano desliga não se liga com um override. Se deixássemos o
  // interruptor activo, o operador ligava, gravava, e a página voltava a
  // mostrar desligado.
  const isLocked = (key: FeatureKey) =>
    tenant?.lockedByPlan
      ? tenant.lockedByPlan.includes(key)
      : (key === 'agents' || key === 'campaigns') && tenant?.plan?.aiAgentsEnabled === false;
  const lockedReason = (f: (typeof FEATURE_LABELS)[number]) => {
    if (tenant?.plan?.productType === 'API_BYOM') return 'Indisponível: o plano API BYOM só usa a API.';
    if (f.needsAi && tenant?.plan?.aiAgentsEnabled === false) return 'Indisponível: o plano deste cliente não inclui IA.';
    if (f.key === 'sms') return 'Indisponível: o plano deste cliente não inclui SMS.';
    return 'Indisponível no plano deste cliente.';
  };

  const saveFeaturesMut = useMutation({
    // Só se gravam as escolhas que o plano deixa fazer. Os valores forçados pelo
    // plano não são escolha do operador: gravá-los como override fazia-os
    // aparecer desligados mais tarde, quando o cliente mudasse de plano.
    mutationFn: () =>
      tenantsApi.updateFeatures(id!, {
        ...(tenant?.featureOverrides ?? {}),
        ...Object.fromEntries(
          Object.entries(featuresDraft ?? {}).filter(([k]) => !isLocked(k as FeatureKey)),
        ),
      }),
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
    mutationFn: () => tenantsApi.createUser(id!, {
      ...userForm,
      accessProfileId: userForm.role === 'OWNER' ? null : userForm.accessProfileId || null,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant', id] });
      void qc.invalidateQueries({ queryKey: ['tenant-access-profiles', id] });
      toast.success('Utilizador criado.');
      setUserModal(false);
      setUserForm({ name: '', email: '', password: '', role: 'MEMBER', accessProfileId: '' });
    },
    onError: (e: Error) => toast.error(e.message || 'Erro ao criar utilizador.'),
  });

  const { data: accessProfilesData } = useQuery({
    queryKey: ['tenant-access-profiles', id],
    queryFn: () => tenantsApi.accessProfiles(id!),
    enabled: !!id && (tab === 'users' || userModal),
  });
  const accessProfiles = accessProfilesData?.profiles ?? [];

  const setUserProfileMut = useMutation({
    mutationFn: ({ userId, accessProfileId }: { userId: string; accessProfileId: string | null }) =>
      tenantsApi.setUserAccessProfile(id!, userId, accessProfileId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant', id] });
      void qc.invalidateQueries({ queryKey: ['tenant-access-profiles', id] });
      toast.success('Perfil de acesso actualizado.');
    },
    onError: (e: Error) => toast.error(e.message || 'Erro ao mudar o perfil.'),
  });

  const [smsTextDraft, setSmsTextDraft] = useState<string | null>(null);

  const missedSmsMut = useMutation({
    mutationFn: (data: { missedCallSms?: boolean; missedCallSmsText?: string | null }) =>
      tenantsApi.update(id!, data as never),
    onSuccess: () => { invalidateTenant(); setSmsTextDraft(null); toast.success('SMS de chamada não atendida actualizado.'); },
    onError: (e: Error) => toast.error(e.message || 'Erro ao actualizar o SMS automático.'),
  });

  const recordingMut = useMutation({
    mutationFn: (data: { recordCalls?: boolean; recordingAnnounce?: boolean }) =>
      tenantsApi.update(id!, data as never),
    onSuccess: () => { invalidateTenant(); toast.success('Gravação de chamadas actualizada.'); },
    onError: (e: Error) => toast.error(e.message || 'Erro ao actualizar a gravação.'),
  });

  const billingOverrideMut = useMutation({
    mutationFn: (mode: BillingMode | null) => tenantsApi.update(id!, { billingModeOverride: mode } as never),
    onSuccess: () => { invalidateTenant(); toast.success('Modo de cobrança do cliente actualizado.'); },
    onError: (e: Error) => toast.error(e.message || 'Erro ao actualizar cobrança.'),
  });

  // Preço por minuto só deste cliente (null = o do plano). Vale para as
  // cobranças por minuto e por segundo; a chamada fixa usa sempre o plano.
  const priceOverrideMut = useMutation({
    mutationFn: (cents: number | null) => tenantsApi.update(id!, { pricePerMinuteOverrideCents: cents } as never),
    onSuccess: () => { invalidateTenant(); toast.success('Preço por minuto do cliente actualizado.'); },
    onError: (e: Error) => toast.error(e.message || 'Erro ao actualizar o preço.'),
  });

  // Limite de chamadas simultâneas do cliente. É este valor (e não o do plano)
  // que o dispatcher de campanhas respeita, por isso tem de ser editável aqui:
  // sem o campo, um cliente com um plano de 10 ficava preso no 1 por omissão e
  // só se destrancava com um UPDATE à mão na base de dados.
  const maxConcurrentMut = useMutation({
    // A API espera `maxConcurrent` (admin/tenants.ts:48). Enviar o nome que o
    // frontend usa (`maxConcurrentCalls`) fazia o zod descartar a chave em
    // silêncio: gravava com sucesso aparente e não mudava nada.
    mutationFn: (value: number) => tenantsApi.update(id!, { maxConcurrent: value } as never),
    onSuccess: () => { invalidateTenant(); toast.success('Limite de chamadas simultâneas actualizado.'); },
    onError: (e: Error) => toast.error(e.message || 'Erro ao actualizar o limite.'),
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
          { key: 'access-profiles', label: 'Perfis de acesso' },
          { key: 'extensions', label: 'Extensões' },
          // Tabela antiga (TenantLine): o CRM não a mostra. Só aparece a quem ainda tem linhas.
          ...((tenant.lines ?? []).length > 0 ? [{ key: 'lines', label: 'Linhas (antigo)' }] : []),
          { key: 'features', label: 'Funcionalidades' },
          { key: 'sms', label: 'SMS' },
          { key: 'whatsapp', label: 'WhatsApp' },
          { key: 'ivr', label: 'IVR' },
          { key: 'api-keys', label: 'Chaves de API' },
          { key: 'calls', label: 'Chamadas' },
          { key: 'campaigns', label: 'Campanhas' },
          { key: 'wallet', label: 'Carteira' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'sms' && <SmsConfigTab tenantId={id!} />}
      {tab === 'whatsapp' && <WhatsappPoolTab tenantId={id!} />}
      {tab === 'ivr' && <TenantIvrTab tenantId={id!} />}
      {tab === 'extensions' && <TenantExtensionsTab tenantId={id!} />}
      {tab === 'api-keys' && <ApiKeysTab tenantId={id!} />}
      {tab === 'access-profiles' && <TenantAccessProfilesTab tenantId={id!} features={tenant.features} />}

      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <LogoCard tenantId={tenant.id} logo={tenant.logoDataUrl ?? null} />
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
              {(tenant.billingModeOverride ?? tenant.plan?.billingMode) !== 'PER_CALL' && (
                <div className="flex justify-between items-center gap-4">
                  <dt className="text-gray-500">Preço por minuto</dt>
                  <dd className="flex items-center gap-2">
                    <Input
                      key={tenant.pricePerMinuteOverrideCents ?? 'plano'}
                      type="number"
                      min={0}
                      step="0.01"
                      className="w-28 text-right"
                      placeholder={tenant.plan ? String(tenant.plan.pricePerMinCents / 100) : ''}
                      defaultValue={tenant.pricePerMinuteOverrideCents != null ? String(tenant.pricePerMinuteOverrideCents / 100) : ''}
                      disabled={priceOverrideMut.isPending}
                      onBlur={(e) => {
                        const raw = e.target.value.trim().replace(',', '.');
                        // Vazio = volta ao preço do plano
                        const cents = raw === '' ? null : Math.round(parseFloat(raw) * 100);
                        if (cents !== null && (Number.isNaN(cents) || cents < 0)) {
                          e.target.value = tenant.pricePerMinuteOverrideCents != null ? String(tenant.pricePerMinuteOverrideCents / 100) : '';
                          return;
                        }
                        if (cents !== (tenant.pricePerMinuteOverrideCents ?? null)) priceOverrideMut.mutate(cents);
                      }}
                    />
                    <span className="text-xs text-gray-500">Kz</span>
                  </dd>
                </div>
              )}
              {(tenant.billingModeOverride ?? tenant.plan?.billingMode) !== 'PER_CALL' && (
                <p className="text-right text-xs text-gray-400 -mt-2">
                  {tenant.pricePerMinuteOverrideCents != null
                    ? 'Preço próprio deste cliente. Apaga o valor para voltar ao do plano.'
                    : `Vazio = usa o do plano${tenant.plan ? ` (${formatAOA(tenant.plan.pricePerMinCents)}/min)` : ''}.`}
                </p>
              )}
              <div className="flex justify-between items-center gap-4">
                <dt className="text-gray-500">Chamadas simultâneas</dt>
                <dd className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={50}
                    className="w-20 text-right"
                    defaultValue={String(tenant.maxConcurrentCalls ?? 1)}
                    disabled={maxConcurrentMut.isPending}
                    onBlur={(e) => {
                      const value = parseInt(e.target.value, 10);
                      if (Number.isNaN(value) || value < 1 || value > 50) {
                        e.target.value = String(tenant.maxConcurrentCalls ?? 1);
                        return;
                      }
                      if (value !== tenant.maxConcurrentCalls) maxConcurrentMut.mutate(value);
                    }}
                  />
                  <span className="text-xs text-gray-400">plano: {tenant.plan?.maxConcurrentCalls ?? '–'}</span>
                </dd>
              </div>
              <div className="flex justify-between"><dt className="text-gray-500">Webhook URL</dt><dd className="font-medium text-right max-w-[200px] truncate">{tenant.webhookUrl ?? '–'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Onboarding</dt><dd className="font-medium">{tenant.onboardingCompletedAt ? formatDate(tenant.onboardingCompletedAt) : 'Pendente'}</dd></div>
            </dl>
          </Card>
          <Card>
            <h2 className="text-sm font-semibold text-gray-700 mb-1">Gravação de chamadas</h2>
            <p className="text-xs text-gray-500 mb-4">
              Grava as chamadas de entrada deste cliente. A pasta e o formato definem-se em Configurações do Sistema.
            </p>
            <div className="space-y-3">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  checked={tenant.recordCalls ?? false}
                  disabled={recordingMut.isPending}
                  onChange={(e) => recordingMut.mutate({ recordCalls: e.target.checked })}
                />
                <span className="text-sm">
                  <span className="font-medium text-gray-800">Gravar as chamadas</span>
                  <span className="block text-xs text-gray-400">Desligado = não se grava nada deste cliente.</span>
                </span>
              </label>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  checked={tenant.recordingAnnounce ?? false}
                  disabled={recordingMut.isPending || !tenant.recordCalls}
                  onChange={(e) => recordingMut.mutate({ recordingAnnounce: e.target.checked })}
                />
                <span className="text-sm">
                  <span className="font-medium text-gray-800">Avisar que a chamada será gravada</span>
                  <span className="block text-xs text-gray-400">
                    Toca o aviso aos dois lados assim que alguém atende, e o aviso fica dentro da própria gravação.
                  </span>
                </span>
              </label>
            </div>
          </Card>
          <Card>
            <h2 className="text-sm font-semibold text-gray-700 mb-1">SMS de chamada não atendida</h2>
            <p className="text-xs text-gray-500 mb-4">
              Envia uma mensagem a quem ficou sem resposta — quem ligou e não foi atendido, ou quem este
              cliente tentou contactar em vão. No máximo um SMS por número por dia. Cada SMS é cobrado ao cliente.
            </p>
            <div className="space-y-3">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  checked={tenant.missedCallSms ?? false}
                  disabled={missedSmsMut.isPending}
                  onChange={(e) => missedSmsMut.mutate({ missedCallSms: e.target.checked })}
                />
                <span className="text-sm">
                  <span className="font-medium text-gray-800">Enviar SMS automático</span>
                  <span className="block text-xs text-gray-400">Precisa da mensagem escrita em baixo.</span>
                </span>
              </label>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Mensagem</label>
                <textarea
                  rows={3}
                  maxLength={480}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="Ligou para a {empresa} e não conseguimos atender. Entraremos em contacto."
                  value={smsTextDraft ?? tenant.missedCallSmsText ?? ''}
                  onChange={(e) => setSmsTextDraft(e.target.value)}
                />
                <p className="mt-1 text-xs text-gray-400">
                  Variáveis: <code>{'{empresa}'}</code> (nome do cliente) e <code>{'{numero}'}</code> (número de destino).
                </p>
                <div className="mt-2 flex justify-end">
                  <Button
                    size="sm"
                    disabled={smsTextDraft === null || missedSmsMut.isPending}
                    onClick={() => missedSmsMut.mutate({ missedCallSmsText: smsTextDraft })}
                  >
                    Guardar mensagem
                  </Button>
                </div>
              </div>
            </div>
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
              onClick={() => { setUserForm({ name: '', email: '', password: '', role: 'MEMBER', accessProfileId: '' }); setUserModal(true); }}
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
                  {u.role === 'OWNER' ? (
                    <span className="w-48 text-xs text-gray-400">Acesso total (proprietário)</span>
                  ) : (
                    <div className="w-48">
                      <Select
                        aria-label={`Perfil de acesso de ${u.name}`}
                        value={u.accessProfileId ?? ''}
                        disabled={setUserProfileMut.isPending}
                        onChange={(e) => setUserProfileMut.mutate({ userId: u.id, accessProfileId: e.target.value || null })}
                      >
                        <option value="">Sem perfil (tudo)</option>
                        {accessProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </Select>
                    </div>
                  )}
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
              <p className="text-xs text-gray-500 mt-0.5">Configuração antiga, que o cliente não vê no CRM. Usa o separador Extensões.</p>
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
          {tenant.plan?.productType === 'API_BYOM' && (
            <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              O plano deste cliente é API BYOM: usa só a API, por isso o painel fica limitado a Developers.
              Para ligar outras funcionalidades, muda-o para um plano com CRM.
            </p>
          )}
          <div className="divide-y divide-gray-100">
            {FEATURE_LABELS.map((f) => {
              const blockedByPlan = isLocked(f.key);
              return (
                <div key={f.key} className="flex items-center justify-between py-3">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{f.label}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {blockedByPlan ? lockedReason(f) : f.hint}
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

      {tab === 'campaigns' && (
        <Card padding={false}>
          {(campaigns?.data ?? []).length === 0 ? (
            <EmptyState icon={<PhoneCall className="h-8 w-8" />} title="Sem campanhas" />
          ) : (
            <>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                  <tr>
                    {['Nome', 'Status', 'Contactos', 'Concluídas', 'Falhadas', 'Criada em'].map((h) => (
                      <th key={h} className="px-6 py-3 text-left font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(campaigns?.data ?? []).map((c) => (
                    <tr key={c.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setOpenCampaignId(c.id)}>
                      <td className="px-6 py-3 font-medium text-gray-900">{c.name}</td>
                      <td className="px-6 py-3">
                        <Badge className={campaignStatusColor[c.status as CampaignStatus]}>
                          {campaignStatusLabel[c.status as CampaignStatus] ?? c.status}
                        </Badge>
                      </td>
                      <td className="px-6 py-3 text-gray-600">{c.totalContacts}</td>
                      <td className="px-6 py-3 text-gray-600">{c.completed}</td>
                      <td className="px-6 py-3 text-gray-600">{c.failedCount}</td>
                      <td className="px-6 py-3 text-gray-500">{formatDate(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination page={campaignPage} total={campaigns?.total ?? 0} perPage={10} onPage={setCampaignPage} />
            </>
          )}
          {openCampaignId && (
            <CampaignDetailModal tenantId={id!} campaignId={openCampaignId} onClose={() => setOpenCampaignId(null)} />
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
          {userForm.role !== 'OWNER' && (
            <Select
              label="Perfil de acesso"
              value={userForm.accessProfileId}
              onChange={(e) => setUserForm((f) => ({ ...f, accessProfileId: e.target.value }))}
              hint="Os perfis criam-se no separador Perfis de acesso."
            >
              <option value="">Sem perfil (todos os módulos activos)</option>
              {accessProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}
        </div>
      </Modal>
    </div>
  );
}

// ─── Chaves de API do cliente ────────────────────────────────────────────────
// No produto API_BYOM o cliente não tem CRM: a chave, os scopes e os IPs de
// origem são definidos aqui. Nos outros produtos isto é uma segunda via — o
// cliente também as gere em Developers no CRM dele.

/** "1.2.3.4, 10.0.0.0/8" → ["1.2.3.4", "10.0.0.0/8"]. Aceita vírgulas ou linhas. */
function parseOrigins(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

function ApiKeysTab({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['tenant-api-keys', tenantId],
    queryFn: () => tenantsApi.apiKeys(tenantId),
  });

  const [showCreate, setShowCreate] = useState(false);
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [origins, setOrigins] = useState('');
  const [rawKey, setRawKey] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editOrigins, setEditOrigins] = useState('');

  const create = useMutation({
    mutationFn: () =>
      tenantsApi.createApiKey(tenantId, { label, scopes, allowedCidrs: parseOrigins(origins) }),
    onSuccess: (key) => {
      setRawKey(key.key);
      void qc.invalidateQueries({ queryKey: ['tenant-api-keys', tenantId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateOrigins = useMutation({
    mutationFn: (keyId: string) =>
      tenantsApi.updateApiKey(tenantId, keyId, { allowedCidrs: parseOrigins(editOrigins) }),
    onSuccess: () => {
      toast.success('Origens actualizadas');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['tenant-api-keys', tenantId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: (keyId: string) => tenantsApi.revokeApiKey(tenantId, keyId),
    onSuccess: () => {
      toast.success('Chave revogada');
      void qc.invalidateQueries({ queryKey: ['tenant-api-keys', tenantId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function closeCreate() {
    setShowCreate(false);
    setLabel('');
    setScopes([]);
    setOrigins('');
    setRawKey('');
  }

  if (isLoading || !data) return <PageSpinner />;

  const keys = data.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {keys.length === 0 ? 'Sem chaves' : `${keys.length} chave(s)`}
        </p>
        <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setShowCreate(true)}>
          Nova chave
        </Button>
      </div>

      {keys.length === 0 ? (
        <EmptyState
          icon={<KeyRound className="h-6 w-6" />}
          title="Sem chaves de API"
          description="Cria uma chave para este cliente aceder à API /v1. Fixa os IPs de origem para restringir o acesso."
        />
      ) : (
        <Card padding={false}>
          <div className="divide-y divide-gray-100">
            {keys.map((k) => (
              <div key={k.id} className="px-5 py-3">
                <div className="flex items-start gap-4">
                  <KeyRound className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-400" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-900">{k.label}</p>
                      <code className="rounded bg-gray-100 px-1.5 text-xs text-gray-500">{k.prefix}…</code>
                      {k.revokedAt && <Badge className="bg-red-100 text-red-700">Revogada</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {k.scopes.map((s) => (
                        <Badge key={s} className="bg-blue-50 text-xs text-blue-700">{s}</Badge>
                      ))}
                    </div>
                    {editing === k.id ? (
                      <div className="mt-2 flex items-center gap-2">
                        <Input
                          value={editOrigins}
                          onChange={(e) => setEditOrigins(e.target.value)}
                          placeholder="102.130.202.155, 10.0.0.0/8"
                        />
                        <Button size="sm" loading={updateOrigins.isPending} onClick={() => updateOrigins.mutate(k.id)}>
                          Guardar
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancelar</Button>
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-gray-500">
                        {k.allowedCidrs.length > 0 ? (
                          <>Só de: <code className="text-gray-700">{k.allowedCidrs.join(', ')}</code></>
                        ) : (
                          <span className="text-amber-600">Qualquer origem — sem restrição de IP</span>
                        )}
                        {!k.revokedAt && (
                          <button
                            className="ml-2 text-blue-600 hover:underline"
                            onClick={() => { setEditing(k.id); setEditOrigins(k.allowedCidrs.join(', ')); }}
                          >
                            editar
                          </button>
                        )}
                      </p>
                    )}
                  </div>
                  <div className="flex-shrink-0 text-right text-xs text-gray-400">
                    <p>{k.lastUsedAt ? `Usada ${formatDate(k.lastUsedAt)}` : 'Nunca usada'}</p>
                    <p className="mt-0.5">Criada {formatDate(k.createdAt)}</p>
                  </div>
                  {!k.revokedAt && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 className="h-4 w-4 text-red-500" />}
                      loading={revoke.isPending}
                      onClick={() => { if (confirm(`Revogar a chave "${k.label}"? O corte é imediato.`)) revoke.mutate(k.id); }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Modal
        open={showCreate}
        onClose={closeCreate}
        title="Nova chave de API"
        footer={
          rawKey ? (
            <Button onClick={closeCreate}>Fechar</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeCreate}>Cancelar</Button>
              <Button
                loading={create.isPending}
                disabled={label.trim().length < 2 || scopes.length === 0}
                onClick={() => create.mutate()}
              >
                Criar
              </Button>
            </>
          )
        }
      >
        {rawKey ? (
          <div className="space-y-3">
            <p className="text-sm font-medium text-emerald-600">Chave criada.</p>
            <div className="rounded-lg bg-gray-900 p-4">
              <p className="break-all font-mono text-sm text-emerald-400">{rawKey}</p>
            </div>
            <p className="text-xs font-medium text-red-600">
              Copia agora — não volta a ser mostrada. Entrega-a ao cliente por um canal seguro.
            </p>
            <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(rawKey); toast.success('Copiada'); }}>
              Copiar
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <Input label="Nome" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ex.: Integração ERP" required />
            <div>
              <p className="mb-2 text-sm font-medium text-gray-700">Permissões</p>
              <div className="grid grid-cols-2 gap-2">
                {data.validScopes.map((s) => (
                  <label key={s} className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={scopes.includes(s)}
                      onChange={() => setScopes((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s])}
                      className="rounded"
                    />
                    <code className="text-xs">{s}</code>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700" htmlFor="new-key-origins">Origens permitidas</label>
              <Input
                id="new-key-origins"
                value={origins}
                onChange={(e) => setOrigins(e.target.value)}
                placeholder="102.130.202.155, 10.0.0.0/8"
              />
              <p className="mt-1 text-xs text-gray-400">
                IPs ou blocos CIDR separados por vírgula. Vazio = a chave funciona de qualquer sítio.
              </p>
            </div>
          </div>
        )}
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

const CONTACT_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pendente',
  QUEUED: 'Na fila',
  IN_PROGRESS: 'Em curso',
  COMPLETED: 'Concluído',
  FAILED: 'Falhou',
  OPTED_OUT: 'Recusou contacto',
  SKIPPED: 'Não marcado',
};

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function CampaignDetailModal({ tenantId, campaignId, onClose }: { tenantId: string; campaignId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { data: c, isLoading, isError } = useQuery({
    queryKey: ['admin', 'tenant-campaign', tenantId, campaignId],
    queryFn: () => tenantsApi.campaign(tenantId, campaignId),
  });

  const cs = c?.contactStatuses ?? {};
  const n = (k: keyof typeof cs) => cs[k] ?? 0;
  const totalContacts = Object.values(cs).reduce<number>((sum, v) => sum + (v ?? 0), 0);
  const attempted = n('COMPLETED') + n('FAILED');
  const answerRate = attempted > 0 && c ? Math.round((c.calls.answered / attempted) * 100) : 0;

  const s = c?.scheduleJson ?? {};
  const days = s.daysOfWeek ?? s.days ?? [];
  const window = s.mode === 'NOW'
    ? 'Imediato'
    : `${String(s.startHour ?? 8).padStart(2, '0')}h às ${String(s.endHour ?? 20).padStart(2, '0')}h`;
  const r = c?.retryPolicy ?? {};

  return (
    <Modal open onClose={onClose} title={c?.name ?? 'Campanha'} size="xl">
      {isLoading ? (
        <PageSpinner />
      ) : isError || !c ? (
        <p className="text-sm text-red-600">Não foi possível carregar a campanha.</p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <Badge className={campaignStatusColor[c.status]}>{campaignStatusLabel[c.status] ?? c.status}</Badge>
            <span>{c.mode === 'FIXED_SCRIPT' ? 'Script fixo' : `Agente IA: ${c.agentName ?? '(sem agente)'}`}</span>
            <span>· Criada em {formatDate(c.createdAt)}</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Contactos', value: totalContacts },
              { label: 'Chamadas feitas', value: c.calls.total },
              { label: 'Taxa de atendimento', value: `${answerRate}%` },
              { label: 'Custo', value: formatAOA(c.calls.totalCostCents) },
            ].map((k) => (
              <div key={k.label} className="rounded-lg border border-gray-200 p-3 text-center">
                <p className="text-lg font-bold text-gray-900">{k.value}</p>
                <p className="text-xs text-gray-500">{k.label}</p>
              </div>
            ))}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Contactos por estado</h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(CONTACT_STATUS_LABELS).map(([k, label]) => (
                <span key={k} className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
                  {label}: <strong>{cs[k as keyof typeof cs] ?? 0}</strong>
                </span>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div><span className="text-gray-500">Janela horária:</span> <span className="text-gray-900">{window}</span></div>
            {s.mode !== 'NOW' && days.length > 0 && (
              <div><span className="text-gray-500">Dias:</span> <span className="text-gray-900">{days.map((d) => WEEKDAYS[d]).join(', ')}</span></div>
            )}
            <div><span className="text-gray-500">Ritmo:</span> <span className="text-gray-900">{c.throttlePerMinute} chamadas/min</span></div>
            <div>
              <span className="text-gray-500">Tentativas:</span>{' '}
              <span className="text-gray-900">
                {r.maxAttempts ?? 1}{(r.maxAttempts ?? 1) > 1 && ` (intervalo ${r.retryDelayMinutes ?? r.delayMinutes ?? 60} min)`}
              </span>
            </div>
            <div><span className="text-gray-500">Duração média:</span> <span className="text-gray-900">{formatDuration(c.calls.avgDurationSecs)}</span></div>
            <div><span className="text-gray-500">Duração total:</span> <span className="text-gray-900">{formatDuration(c.calls.totalDurationSecs)}</span></div>
          </div>

          {c.mode === 'FIXED_SCRIPT' && c.scriptText && (
            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Script</h3>
              <p className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 rounded-lg p-3">{c.scriptText}</p>
            </div>
          )}

          {c.summary && (
            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Resumo</h3>
              <p className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 rounded-lg p-3">{c.summary}</p>
            </div>
          )}

          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Últimos contactos</h3>
            {c.recentContacts.length === 0 ? (
              <p className="text-sm text-gray-500">Sem contactos nesta campanha.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                    <tr>
                      {['Contacto', 'Estado', 'Chamada', 'Tent.', 'Duração', 'Custo', 'Actualizado'].map((h) => (
                        <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {c.recentContacts.map((rc) => (
                      <tr
                        key={rc.id}
                        className={rc.callId ? 'hover:bg-gray-50 cursor-pointer' : undefined}
                        onClick={rc.callId ? () => navigate(`/calls/${rc.callId}`) : undefined}
                      >
                        <td className="px-3 py-2">
                          <p className="text-gray-900">{rc.name ?? rc.phone}</p>
                          {rc.name && <p className="text-xs text-gray-500">{rc.phone}</p>}
                        </td>
                        <td className="px-3 py-2 text-gray-600">{CONTACT_STATUS_LABELS[rc.status] ?? rc.status}</td>
                        <td className="px-3 py-2">
                          {rc.callStatus ? (
                            <Badge className={callStatusColor[rc.callStatus]}>{callStatusLabel[rc.callStatus]}</Badge>
                          ) : <span className="text-gray-400">(sem chamada)</span>}
                        </td>
                        <td className="px-3 py-2 text-gray-600">{rc.attempts}</td>
                        <td className="px-3 py-2 text-gray-600">{rc.durationSecs != null ? formatDuration(rc.durationSecs) : ''}</td>
                        <td className="px-3 py-2 text-gray-600">{rc.costCents != null ? formatAOA(rc.costCents) : ''}</td>
                        <td className="px-3 py-2 text-gray-500">{formatDate(rc.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

const MAX_LOGO_BYTES = 256 * 1024;

/** Logo do cliente no CRM. Guardado como data URL; sem logo usa-se o da Comunica. */
function LogoCard({ tenantId, logo }: { tenantId: string; logo: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (dataUrl: string | null) => tenantsApi.updateLogo(tenantId, dataUrl),
    onSuccess: (_r, dataUrl) => {
      toast.success(dataUrl ? 'Logo actualizado' : 'Logo removido');
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant', tenantId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Não foi possível guardar o logo'),
  });

  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.type)) {
      toast.error('Formato inválido — use PNG, JPG, WEBP ou SVG');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error('Logo demasiado grande (máx. 256 KB)');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => save.mutate(reader.result as string);
    reader.readAsDataURL(file);
  };

  return (
    <Card>
      <h2 className="text-sm font-semibold text-gray-700 mb-1">Logo no CRM</h2>
      <p className="text-xs text-gray-500 mb-4">Aparece no topo do menu do cliente. PNG, JPG, WEBP ou SVG até 256 KB, fundo transparente de preferência.</p>
      <div className="flex items-center gap-4">
        {/* Pré-visualização sobre o mesmo fundo escuro do menu do CRM */}
        <div className="flex h-16 w-40 items-center justify-center rounded-lg bg-slate-900 p-2">
          <div className="flex items-center justify-center rounded-lg bg-white px-2 py-1.5">
            <img src={logo ?? '/logo.png'} alt="Logo do cliente" className="h-8 max-w-[120px] object-contain" />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <label className="inline-flex cursor-pointer items-center justify-center rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">
            {save.isPending ? 'A guardar…' : logo ? 'Trocar logo' : 'Carregar logo'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="sr-only"
              disabled={save.isPending}
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          {logo && (
            <Button size="sm" variant="ghost" onClick={() => save.mutate(null)} disabled={save.isPending}>
              Repor logo da Comunica
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

const WA_POOL_COLOR: Record<WaPoolStatus, string> = {
  ACTIVE: 'bg-green-100 text-green-700',
  DEGRADED: 'bg-amber-100 text-amber-700',
  STANDBY: 'bg-blue-100 text-blue-700',
  FAILED: 'bg-red-100 text-red-700',
  DISABLED: 'bg-gray-100 text-gray-600',
};

const VERDICT_LABEL: Record<string, string> = {
  ok: 'OK', warn: 'Aviso', ignore: 'Inconclusivo (Meta/rede/token)', suspect: 'Suspeito', fatal: 'Indisponível',
};

/** Números WhatsApp do cliente e estado do pool Active/Standby. O cliente gere-os no CRM; aqui o suporte vê e faz health check. */
function WhatsappPoolTab({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['tenant-whatsapp', tenantId],
    queryFn: () => tenantsApi.whatsappPool(tenantId),
    refetchInterval: 30_000,
  });
  const check = useMutation({
    mutationFn: (inboxId?: string) => tenantsApi.whatsappCheck(tenantId, inboxId),
    onSuccess: ({ results }) => {
      for (const r of results) {
        const name = data?.numbers.find((n) => n.id === r.id)?.displayPhone ?? r.id;
        const msg = `${name}: ${VERDICT_LABEL[r.verdict] ?? r.verdict} — ${r.detail}`;
        if (r.verdict === 'ok') toast.success(msg);
        else toast.error(msg);
      }
      void qc.invalidateQueries({ queryKey: ['tenant-whatsapp', tenantId] });
    },
    onError: () => toast.error('Erro ao fazer o health check'),
  });
  if (isLoading || !data) return <PageSpinner />;
  const inService = data.numbers.find((n) => n.status === 'ACTIVE' || n.status === 'DEGRADED');
  const count = (st: WaPoolStatus) => data.numbers.filter((n) => n.status === st).length;

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <div>
            <span className="text-gray-500">Em serviço: </span>
            {inService ? (
              <span className="font-medium text-gray-900">{inService.name} · {inService.displayPhone ?? '—'}</span>
            ) : (
              <span className="font-medium text-red-600">nenhum — o botão do site está sem destino</span>
            )}
          </div>
          <div className="text-gray-500">Standby: <b className="text-gray-900">{count('STANDBY')}</b></div>
          <div className="text-gray-500">Falhados: <b className="text-gray-900">{count('FAILED')}</b></div>
          <div className="text-gray-500">Desactivados: <b className="text-gray-900">{count('DISABLED')}</b></div>
        </div>
        <p className="mt-3 truncate text-xs text-gray-500">Link do botão: <code>{data.poolUrl}</code></p>
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">Números</h2>
          {data.numbers.length > 0 && (
            <Button size="sm" variant="secondary" icon={<RefreshCw className="h-4 w-4" />} loading={check.isPending && check.variables === undefined} disabled={check.isPending} onClick={() => check.mutate(undefined)}>
              Health check a todos
            </Button>
          )}
        </div>
        <p className="mb-3 text-xs text-gray-500">O health check consulta a Meta agora. Se o número em serviço estiver comprovadamente em baixo, a troca para o standby seguinte acontece logo.</p>
        {data.numbers.length === 0 ? (
          <EmptyState title="Sem números WhatsApp" description="O cliente ainda não ligou nenhum número no CRM." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-gray-500">
                <tr>
                  <th className="py-2 pr-3">#</th>
                  <th className="pr-3">Número</th>
                  <th className="pr-3">Estado</th>
                  <th className="pr-3">Último check</th>
                  <th className="pr-3">Último erro</th>
                  <th className="pr-3">Última mudança</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.numbers.map((n) => (
                  <tr key={n.id} className="border-t border-gray-100 align-top">
                    <td className="py-2 pr-3 text-gray-500">{n.priority ?? '—'}</td>
                    <td className="pr-3">
                      <div className="font-medium text-gray-900">{n.displayPhone ?? '—'}</div>
                      <div className="text-xs text-gray-500">{n.name}{n.verifiedName ? ` · ${n.verifiedName}` : ''} · ID {n.phoneNumberId ?? '—'}</div>
                    </td>
                    <td className="pr-3">
                      {n.status ? <Badge className={WA_POOL_COLOR[n.status]}>{n.status}</Badge> : '—'}
                      {!n.enabled && <div className="text-xs text-gray-400">canal desligado</div>}
                      {n.failCount > 0 && <div className="text-xs text-amber-600">{n.failCount} falha(s) seguida(s)</div>}
                    </td>
                    <td className="pr-3 text-xs text-gray-600">{n.lastCheckAt ? formatDate(n.lastCheckAt) : '—'}</td>
                    <td className="max-w-[260px] pr-3 text-xs text-gray-600" title={n.lastError ?? ''}>
                      <span className="line-clamp-2">{n.lastError ?? '—'}</span>
                    </td>
                    <td className="pr-3 text-xs text-gray-600">{n.statusAt ? formatDate(n.statusAt) : '—'}</td>
                    <td>
                      <Button size="sm" variant="ghost" loading={check.isPending && check.variables === n.id} disabled={check.isPending} onClick={() => check.mutate(n.id)}>
                        Health check
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Histórico de trocas</h2>
        {data.events.length === 0 ? (
          <p className="text-sm text-gray-400">Sem trocas registadas.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {data.events.map((e) => (
              <li key={e.id} className="flex gap-3">
                <span className="w-36 shrink-0 text-xs text-gray-500">{formatDate(e.createdAt)}</span>
                <span className={e.severity === 'ERROR' ? 'text-red-700' : 'text-gray-700'}>{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
