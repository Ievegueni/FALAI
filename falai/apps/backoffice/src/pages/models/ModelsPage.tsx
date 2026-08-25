import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, XCircle, Ban, Cpu, Activity, AlertTriangle } from 'lucide-react';
import { modelsApi } from '@/lib/api';
import { Card, Button, Badge, PageSpinner, EmptyState, Modal, Textarea, Pagination } from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';
import { formatDate } from '@/lib/utils';
import type { AgentStatus, ModelProtocol } from '@/types';

/**
 * Moderação dos modelos dos clientes (produto API_BYOM).
 *
 * O cliente treina o modelo dele onde quiser e regista aqui o endereço. Esta
 * página é onde o controlo acontece: nada entra em chamadas reais sem passar a
 * ACTIVE, e o botão Bloquear corta na hora.
 */

const STATUS_COLOR: Record<AgentStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  PENDING_REVIEW: 'bg-amber-100 text-amber-700',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  PAUSED: 'bg-blue-100 text-blue-700',
  BLOCKED: 'bg-red-200 text-red-900',
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  DRAFT: 'Rascunho',
  PENDING_REVIEW: 'Em revisão',
  ACTIVE: 'Activo',
  PAUSED: 'Pausado',
  BLOCKED: 'Bloqueado',
};

const PROTOCOL_LABEL: Record<ModelProtocol, string> = {
  FALAI_TURN: 'Falaí (nativo)',
  OPENAI_CHAT: 'OpenAI compatível',
  ANTHROPIC_MESSAGES: 'Anthropic Messages',
};

/** Acima disto, a latência do modelo do cliente estraga a conversa. */
const LATENCY_WARN_MS = 2000;

export function ModelsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<AgentStatus | 'ALL'>('PENDING_REVIEW');
  const [reasonModal, setReasonModal] = useState<{ id: string; name: string; block: boolean } | null>(null);
  const [reason, setReason] = useState('');
  const [testing, setTesting] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'models', page, filter],
    queryFn: () =>
      modelsApi.list({
        page,
        perPage: 20,
        ...(filter !== 'ALL' && { status: filter }),
      }),
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin', 'models'] });

  const approveMut = useMutation({
    mutationFn: (id: string) => modelsApi.approve(id),
    onSuccess: () => { refresh(); toast.success('Modelo aprovado — passa a servir chamadas.'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const reasonMut = useMutation({
    mutationFn: ({ id, block }: { id: string; block: boolean }) =>
      block ? modelsApi.block(id, reason) : modelsApi.reject(id, reason),
    onSuccess: (_, { block }) => {
      refresh();
      toast.success(block ? 'Modelo bloqueado. O corte é imediato.' : 'Modelo devolvido ao cliente.');
      setReasonModal(null);
      setReason('');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const testMut = useMutation({
    mutationFn: (id: string) => modelsApi.test(id),
    onSuccess: (res) => {
      refresh();
      if (res.ok) toast.success(`Endpoint respondeu em ${res.latencyMs}ms`);
      else toast.error(res.details ?? 'O endpoint não respondeu');
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setTesting(null),
  });

  if (isLoading && !data) return <PageSpinner />;

  const models = data?.data ?? [];

  return (
    <div className="space-y-5 p-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Modelos dos clientes</h1>
        <p className="text-sm text-gray-500">
          Modelos que os clientes trazem por API. Nenhum entra em chamadas reais sem ser aprovado aqui.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {(['PENDING_REVIEW', 'ACTIVE', 'DRAFT', 'BLOCKED', 'ALL'] as const).map((s) => (
          <button
            key={s}
            onClick={() => { setFilter(s); setPage(1); }}
            className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${
              filter === s ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {s === 'ALL' ? 'Todos' : STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {models.length === 0 ? (
        <EmptyState
          icon={<Cpu className="h-6 w-6" />}
          title="Sem modelos"
          description="Ainda nenhum cliente registou um modelo próprio neste estado."
        />
      ) : (
        <div className="space-y-3">
          {models.map((m) => (
            <Card key={m.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-gray-900">{m.name}</h3>
                    <Badge className={STATUS_COLOR[m.status]}>{STATUS_LABEL[m.status]}</Badge>
                    <Badge className="bg-slate-100 text-slate-700">{PROTOCOL_LABEL[m.protocol]}</Badge>
                    {m.violations > 0 && (
                      <Badge className="bg-red-100 text-red-700">
                        {m.violations} violação(ões) de guardrail
                      </Badge>
                    )}
                  </div>

                  <p className="mt-1 text-xs text-gray-500">
                    {m.tenant?.name ?? m.tenantId}
                    {m._count?.agents !== undefined && ` · ${m._count.agents} agente(s) a usá-lo`}
                  </p>

                  <code className="mt-2 block break-all rounded bg-gray-50 px-2 py-1 text-xs text-gray-700">
                    {m.endpointUrl}
                    {m.modelName ? ` · ${m.modelName}` : ''}
                  </code>

                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                    <span>Timeout {m.timeoutMs}ms</span>
                    <span>Resposta ≤ {m.maxReplyChars} caracteres</span>
                    {m.lastLatencyMs !== null && (
                      <span className={m.lastLatencyMs > LATENCY_WARN_MS ? 'font-medium text-amber-600' : ''}>
                        Última latência {m.lastLatencyMs}ms
                        {m.lastLatencyMs > LATENCY_WARN_MS && ' — lento para voz'}
                      </span>
                    )}
                    {m.lastHealthAt && <span>Testado {formatDate(m.lastHealthAt)}</span>}
                  </div>

                  {m.lastError && (
                    <p className="mt-2 flex items-start gap-1.5 text-xs text-red-600">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                      <span>{m.lastError}</span>
                    </p>
                  )}
                </div>

                <div className="flex flex-shrink-0 flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<Activity className="h-4 w-4" />}
                    loading={testing === m.id && testMut.isPending}
                    onClick={() => { setTesting(m.id); testMut.mutate(m.id); }}
                  >
                    Testar
                  </Button>

                  {m.status === 'PENDING_REVIEW' && (
                    <>
                      <Button
                        size="sm"
                        icon={<CheckCircle className="h-4 w-4" />}
                        loading={approveMut.isPending}
                        onClick={() => approveMut.mutate(m.id)}
                      >
                        Aprovar
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        icon={<XCircle className="h-4 w-4" />}
                        onClick={() => setReasonModal({ id: m.id, name: m.name, block: false })}
                      >
                        Rejeitar
                      </Button>
                    </>
                  )}

                  {m.status !== 'BLOCKED' && (
                    <Button
                      size="sm"
                      variant="danger"
                      icon={<Ban className="h-4 w-4" />}
                      onClick={() => setReasonModal({ id: m.id, name: m.name, block: true })}
                    >
                      Bloquear
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {data && data.total > data.perPage && (
        <Pagination
          page={page}
          total={data.total}
          perPage={data.perPage}
          onPage={setPage}
        />
      )}

      <Modal
        open={reasonModal !== null}
        onClose={() => { setReasonModal(null); setReason(''); }}
        title={reasonModal?.block ? `Bloquear "${reasonModal.name}"` : `Rejeitar "${reasonModal?.name ?? ''}"`}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setReasonModal(null); setReason(''); }}>Cancelar</Button>
            <Button
              variant={reasonModal?.block ? 'danger' : 'primary'}
              disabled={reason.trim().length < 10}
              loading={reasonMut.isPending}
              onClick={() => reasonModal && reasonMut.mutate({ id: reasonModal.id, block: reasonModal.block })}
            >
              {reasonModal?.block ? 'Bloquear' : 'Rejeitar'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            {reasonModal?.block
              ? 'O modelo deixa de servir chamadas imediatamente. Os agentes que o usam passam a responder pelo motor da plataforma.'
              : 'O modelo volta a Rascunho. O cliente corrige e submete de novo.'}
          </p>
          <Textarea
            label="Motivo (fica no registo e é visível ao cliente)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Mínimo 10 caracteres"
          />
        </div>
      </Modal>
    </div>
  );
}
