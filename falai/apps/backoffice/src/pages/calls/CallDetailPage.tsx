import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Phone, Clock, DollarSign, User, AlertTriangle } from 'lucide-react';
import { callsApi } from '@/lib/api';
import { Card, Button, Badge, PageSpinner, StatCard } from '@/components/ui';
import { formatDate, formatDuration, formatAOA, callStatusColor, callStatusLabel } from '@/lib/utils';
import type { CallStatus } from '@/types';

export function CallDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: call, isLoading } = useQuery({
    queryKey: ['admin', 'call', id],
    queryFn: () => callsApi.get(id!),
    enabled: !!id,
  });

  if (isLoading) return <PageSpinner />;
  if (!call) return <div className="p-6 text-gray-500">Chamada não encontrada.</div>;

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => navigate(-1)}>
          Voltar
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-gray-900">Chamada</h1>
            <Badge className={callStatusColor[call.status as CallStatus]}>
              {callStatusLabel[call.status as CallStatus] ?? call.status}
            </Badge>
          </div>
          <p className="text-sm text-gray-500 font-mono">{call.id}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Destino" value={call.to} icon={<Phone className="h-5 w-5" />} />
        <StatCard label="Duração" value={call.durationSecs !== undefined ? formatDuration(call.durationSecs) : '–'} icon={<Clock className="h-5 w-5" />} />
        <StatCard label="Custo" value={call.costCents !== undefined ? formatAOA(call.costCents) : '–'} icon={<DollarSign className="h-5 w-5" />} />
        <StatCard label="Tenant" value={call.tenantId.slice(0, 8) + '…'} icon={<User className="h-5 w-5" />} />
      </div>

      {call.failReason && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 flex gap-3">
          <AlertTriangle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-800 mb-1">Motivo da falha</p>
            <p className="text-sm text-red-700 font-mono break-all">{call.failReason}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card>
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Detalhes</h2>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-gray-500">Agente</dt><dd className="font-medium font-mono text-xs">{call.agentId ?? '–'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Criada em</dt><dd>{formatDate(call.createdAt)}</dd></div>
            {call.startedAt && <div className="flex justify-between"><dt className="text-gray-500">Iniciada em</dt><dd>{formatDate(call.startedAt)}</dd></div>}
            {call.endedAt && <div className="flex justify-between"><dt className="text-gray-500">Terminada em</dt><dd>{formatDate(call.endedAt)}</dd></div>}
            {call.outcome && <div className="flex justify-between"><dt className="text-gray-500">Resultado</dt><dd className="font-medium">{call.outcome}</dd></div>}
          </dl>
        </Card>

        {(call.turns ?? []).length > 0 && (
          <Card>
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Transcrição ({call.turns?.length} turnos)</h2>
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {(call.turns ?? []).map((t, i) => (
                <div key={i} className={`flex gap-3 ${t.role === 'assistant' ? 'flex-row-reverse' : ''}`}>
                  <div className={`flex-shrink-0 flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${t.role === 'assistant' ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600'}`}>
                    {t.role === 'assistant' ? 'IA' : 'U'}
                  </div>
                  <div className={`max-w-[80%] rounded-lg px-3 py-2 text-xs ${t.role === 'assistant' ? 'bg-indigo-50 text-indigo-900' : 'bg-gray-100 text-gray-800'}`}>
                    {t.text}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
