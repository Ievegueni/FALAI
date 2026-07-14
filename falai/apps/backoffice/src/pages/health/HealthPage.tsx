import { useQuery } from '@tanstack/react-query';
import { CheckCircle, AlertTriangle, XCircle, Clock, Activity } from 'lucide-react';
import { healthApi } from '@/lib/api';
import { Card, Badge, PageSpinner } from '@/components/ui';
import { formatDate } from '@/lib/utils';
import type { ProviderHealth } from '@/types';

const statusIcon = {
  ok: <CheckCircle className="h-5 w-5 text-emerald-500" />,
  degraded: <AlertTriangle className="h-5 w-5 text-amber-500" />,
  down: <XCircle className="h-5 w-5 text-red-500" />,
  unknown: <Clock className="h-5 w-5 text-gray-400" />,
};
const statusColor: Record<ProviderHealth['status'], string> = {
  ok: 'bg-emerald-100 text-emerald-700',
  degraded: 'bg-amber-100 text-amber-700',
  down: 'bg-red-100 text-red-700',
  unknown: 'bg-gray-100 text-gray-500',
};
const statusLabel: Record<ProviderHealth['status'], string> = {
  ok: 'Operacional',
  degraded: 'Degradado',
  down: 'Indisponível',
  unknown: 'Desconhecido',
};

export function HealthPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'health'],
    queryFn: () => healthApi.status(),
    refetchInterval: 15_000,
  });

  if (isLoading && !data) return <PageSpinner />;

  const providers = data?.providers ?? [];
  const events = data?.recentEvents ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Saúde do Sistema</h1>
          <p className="text-sm text-gray-500">Estado dos fornecedores e capacidade — actualiza de 15 em 15 segundos</p>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-gray-100 px-4 py-2">
          <Activity className="h-4 w-4 text-indigo-600" />
          <span className="text-sm font-medium text-gray-700">
            {data?.concurrentCalls ?? 0} / {data?.concurrentCapacity ?? '?'} chamadas
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {providers.map((p) => (
          <Card key={p.name}>
            <div className="flex items-start gap-3">
              {statusIcon[p.status]}
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-gray-900">{p.name}</h3>
                  <Badge className={statusColor[p.status]}>{statusLabel[p.status]}</Badge>
                </div>
                {p.latencyMs !== undefined && (
                  <p className="text-xs text-gray-500 mt-1">Latência: {p.latencyMs}ms</p>
                )}
                {p.detail && (
                  <p className="text-xs text-gray-400 mt-1">{p.detail}</p>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Card padding={false}>
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Eventos recentes do sistema</h2>
        </div>
        {events.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-gray-400">Nenhum evento recente</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {events.map((e, i) => (
              <div key={i} className="flex items-start gap-4 px-6 py-3">
                <div className={`mt-0.5 flex h-2 w-2 flex-shrink-0 rounded-full ${e.severity === 'error' ? 'bg-red-500' : e.severity === 'warning' ? 'bg-amber-500' : 'bg-gray-400'}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800">{e.message}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{formatDate(e.createdAt)}</p>
                </div>
                <Badge className={e.severity === 'error' ? 'bg-red-100 text-red-700' : e.severity === 'warning' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}>
                  {e.severity}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
