import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Phone, AlertCircle } from 'lucide-react';
import { callsApi } from '@/lib/api';
import { Card, Badge, Pagination, EmptyState, PageSpinner } from '@/components/ui';
import { formatDate, formatDuration, formatAOA, callStatusColor, callStatusLabel } from '@/lib/utils';
import type { CallStatus } from '@/types';

function FailReasonBadge({ reason }: { reason: string }) {
  return (
    <span className="group relative inline-flex items-center gap-1 cursor-help">
      <AlertCircle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />
      <span className="max-w-[140px] truncate text-red-600 text-xs">{reason}</span>
      <span className="pointer-events-none absolute bottom-full left-0 z-10 mb-1.5 hidden w-72 rounded-lg bg-gray-900 px-3 py-2 text-xs text-white shadow-lg group-hover:block whitespace-pre-wrap">
        {reason}
      </span>
    </span>
  );
}

export function CallsPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<CallStatus | ''>('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'calls', page, status],
    queryFn: () => callsApi.list({ page, status: status || undefined }),
  });

  if (isLoading && !data) return <PageSpinner />;

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Chamadas</h1>
          <p className="text-sm text-gray-500">{data?.total ?? 0} chamadas registadas</p>
        </div>
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value as CallStatus | ''); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        >
          <option value="">Todos os status</option>
          <option value="QUEUED">Na fila</option>
          <option value="DIALING">A ligar</option>
          <option value="RINGING">A chamar</option>
          <option value="IN_PROGRESS">Em curso</option>
          <option value="COMPLETED">Concluída</option>
          <option value="NO_ANSWER">Sem resposta</option>
          <option value="FAILED">Falhou</option>
          <option value="CANCELLED">Cancelada</option>
          <option value="ESCALATED">Escalada</option>
        </select>
      </div>

      <Card padding={false}>
        {(data?.data ?? []).length === 0 ? (
          <EmptyState icon={<Phone className="h-8 w-8" />} title="Nenhuma chamada encontrada" />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  {['Destino', 'Status / Erro', 'Tenant', 'Agente', 'Duração', 'Custo', 'Criada em'].map((h) => (
                    <th key={h} className="px-6 py-3 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(data?.data ?? []).map((c) => (
                  <tr
                    key={c.id}
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => navigate(`/calls/${c.id}`)}
                  >
                    <td className="px-6 py-3 font-medium text-gray-900">{c.to}</td>
                    <td className="px-6 py-3">
                      <div className="flex flex-col gap-1">
                        <Badge className={callStatusColor[c.status as CallStatus]}>
                          {callStatusLabel[c.status as CallStatus] ?? c.status}
                        </Badge>
                        {c.failReason && <FailReasonBadge reason={c.failReason} />}
                      </div>
                    </td>
                    <td className="px-6 py-3 text-gray-600">{c.tenant?.name ?? '–'}</td>
                    <td className="px-6 py-3 text-gray-600">{c.agent?.name ?? '–'}</td>
                    <td className="px-6 py-3 text-gray-600">{c.durationSecs !== undefined ? formatDuration(c.durationSecs) : '–'}</td>
                    <td className="px-6 py-3 text-gray-600">{c.costCents !== undefined ? formatAOA(c.costCents) : '–'}</td>
                    <td className="px-6 py-3 text-gray-500">{formatDate(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} total={data?.total ?? 0} perPage={data?.perPage ?? 20} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
