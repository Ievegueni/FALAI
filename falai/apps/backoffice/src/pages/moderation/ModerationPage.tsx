import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, XCircle, Ban, ShieldCheck } from 'lucide-react';
import { moderationApi } from '@/lib/api';
import { Card, Button, Badge, PageSpinner, EmptyState, Modal, Textarea, Pagination } from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';
import { formatDate } from '@/lib/utils';
import type { AgentReviewStatus, AgentStatus } from '@/types';

const statusColor: Record<AgentReviewStatus, string> = {
  PENDING_REVIEW: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-red-100 text-red-700',
  BLOCKED: 'bg-red-200 text-red-900',
};
const statusLabel: Record<AgentReviewStatus, string> = {
  PENDING_REVIEW: 'Em revisão',
  APPROVED: 'Aprovado',
  REJECTED: 'Rejeitado',
  BLOCKED: 'Bloqueado',
};

export function ModerationPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<AgentReviewStatus | 'ALL'>('PENDING_REVIEW');
  const [rejectModal, setRejectModal] = useState<{ id: string; block: boolean } | null>(null);
  const [reason, setReason] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'moderation', page, filter],
    queryFn: () => moderationApi.list({ page, perPage: 20, status: filter === 'ALL' ? undefined : (filter as AgentReviewStatus) }),
  });

  const approveMut = useMutation({
    mutationFn: (id: string) => moderationApi.approve(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'moderation'] }); toast.success('Agente aprovado.'); },
  });

  const rejectMut = useMutation({
    mutationFn: ({ id, block }: { id: string; block: boolean }) =>
      block ? moderationApi.block(id, reason) : moderationApi.reject(id, reason),
    onSuccess: (_, { block }) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'moderation'] });
      toast.success(block ? 'Agente bloqueado.' : 'Agente rejeitado.');
      setRejectModal(null);
      setReason('');
    },
  });

  if (isLoading && !data) return <PageSpinner />;

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Moderação de Agentes</h1>
        <p className="text-sm text-gray-500">Revê e aprova agentes submetidos pelos tenants</p>
      </div>

      <div className="flex gap-2">
        {(['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'BLOCKED', 'ALL'] as const).map((s) => (
          <button
            key={s}
            onClick={() => { setFilter(s); setPage(1); }}
            className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${filter === s ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {s === 'ALL' ? 'Todos' : statusLabel[s]}
            {s === 'PENDING_REVIEW' && (data?.total !== undefined && filter !== 'PENDING_REVIEW') ? '' : ''}
          </button>
        ))}
      </div>

      <Card padding={false}>
        {(data?.data ?? []).length === 0 ? (
          <EmptyState icon={<ShieldCheck className="h-8 w-8" />} title="Nenhum agente para moderar" description="Todos os agentes foram revistos." />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  {['Agente', 'Tenant', 'Status', 'Submetido em', 'Acções'].map((h) => (
                    <th key={h} className="px-6 py-3 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(data?.data ?? []).map((a) => (
                  <tr key={a.id} className="hover:bg-gray-50">
                    <td className="px-6 py-3">
                      <p className="font-medium text-gray-900">{a.name}</p>
                      <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{a.objective}</p>
                    </td>
                    <td className="px-6 py-3 text-gray-600">{a.tenantName}</td>
                    <td className="px-6 py-3">
                      <Badge className={statusColor[a.reviewStatus]}>
                        {statusLabel[a.reviewStatus]}
                      </Badge>
                    </td>
                    <td className="px-6 py-3 text-gray-500">{formatDate(a.submittedAt)}</td>
                    <td className="px-6 py-3">
                      {(a.status as AgentStatus) === 'PENDING_REVIEW' && (
                        <div className="flex gap-2">
                          <Button
                            size="sm" variant="outline"
                            icon={<CheckCircle className="h-3.5 w-3.5 text-emerald-600" />}
                            onClick={() => approveMut.mutate(a.id)}
                            loading={approveMut.isPending}
                          >
                            Aprovar
                          </Button>
                          <Button
                            size="sm" variant="outline"
                            icon={<XCircle className="h-3.5 w-3.5 text-red-500" />}
                            onClick={() => setRejectModal({ id: a.id, block: false })}
                          >
                            Rejeitar
                          </Button>
                          <Button
                            size="sm" variant="danger"
                            icon={<Ban className="h-3.5 w-3.5" />}
                            onClick={() => setRejectModal({ id: a.id, block: true })}
                          >
                            Bloquear
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} total={data?.total ?? 0} perPage={20} onPage={setPage} />
          </>
        )}
      </Card>

      <Modal
        open={rejectModal !== null}
        onClose={() => { setRejectModal(null); setReason(''); }}
        title={rejectModal?.block ? 'Bloquear agente' : 'Rejeitar agente'}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => { setRejectModal(null); setReason(''); }}>Cancelar</Button>
            <Button
              variant={rejectModal?.block ? 'danger' : 'primary'}
              loading={rejectMut.isPending}
              onClick={() => rejectModal && rejectMut.mutate(rejectModal)}
            >
              {rejectModal?.block ? 'Bloquear' : 'Rejeitar'}
            </Button>
          </>
        }
      >
        <Textarea
          label="Motivo"
          placeholder="Descreve o motivo da decisão…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Modal>
    </div>
  );
}
