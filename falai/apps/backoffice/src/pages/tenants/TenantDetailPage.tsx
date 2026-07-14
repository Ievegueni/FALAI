import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, CheckCircle, DollarSign, Phone } from 'lucide-react';
import { tenantsApi } from '@/lib/api';
import {
  Card, Button, Badge, Tabs, PageSpinner, Modal, Input,
  EmptyState, Pagination,
} from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';
import {
  formatAOA, formatDate, formatDuration,
  tenantStatusColor, tenantStatusLabel,
  callStatusColor, callStatusLabel, txTypeLabel,
} from '@/lib/utils';
import type { TenantStatus, CallStatus, TransactionType } from '@/types';

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

  const { data: tenant, isLoading } = useQuery({
    queryKey: ['admin', 'tenant', id],
    queryFn: () => tenantsApi.get(id!),
    enabled: !!id,
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

  const suspendMut = useMutation({
    mutationFn: () => tenantsApi.suspend(id!),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'tenant', id] }); toast.success('Tenant suspenso.'); },
  });

  const reactivateMut = useMutation({
    mutationFn: () => tenantsApi.reactivate(id!),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'tenant', id] }); toast.success('Tenant reactivado.'); },
  });

  const adjustMut = useMutation({
    mutationFn: () => tenantsApi.adjustBalance(id!, { amountCents: Math.round(parseFloat(adjustAmt) * 100), note: adjustNote }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant', id] });
      toast.success('Saldo ajustado.');
      setAdjustModal(false);
      setAdjustAmt('');
      setAdjustNote('');
    },
  });

  if (isLoading || !tenant) return <PageSpinner />;

  const isSuspended = tenant.status === 'SUSPENDED' || tenant.status === 'CLOSED';

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
          <Button variant="outline" size="sm" icon={<DollarSign className="h-4 w-4" />} onClick={() => setAdjustModal(true)}>
            Ajustar saldo
          </Button>
          {isSuspended ? (
            <Button size="sm" icon={<CheckCircle className="h-4 w-4" />} onClick={() => reactivateMut.mutate()} loading={reactivateMut.isPending}>
              Reactivar
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
          { key: 'calls', label: 'Chamadas' },
          { key: 'wallet', label: 'Carteira' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Card>
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Informações</h2>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between"><dt className="text-gray-500">Plano</dt><dd className="font-medium">{tenant.plan?.name ?? '–'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Saldo</dt><dd className="font-medium">{formatAOA(tenant.balanceCents)}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Limite crédito</dt><dd className="font-medium">{formatAOA(tenant.creditLimitCents)}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Webhook URL</dt><dd className="font-medium text-right max-w-[200px] truncate">{tenant.webhookUrl ?? '–'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Onboarding</dt><dd className="font-medium">{tenant.onboardingCompletedAt ? formatDate(tenant.onboardingCompletedAt) : 'Pendente'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Criado em</dt><dd className="font-medium">{formatDate(tenant.createdAt)}</dd></div>
            </dl>
          </Card>
        </div>
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
    </div>
  );
}
