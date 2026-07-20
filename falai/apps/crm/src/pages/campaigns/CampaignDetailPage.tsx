import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Play, Pause, Square, RefreshCw } from 'lucide-react';
import { campaignsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import { campaignStatusLabel, campaignStatusColor, formatDate, formatAOA, daysOfWeekLabel } from '@/lib/utils';

function ProgressBar({ value, max, color = 'blue' }: { value: number; max: number; color?: string }) {
  const pct = max === 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  const bg = color === 'emerald' ? 'bg-emerald-500' : color === 'red' ? 'bg-red-500' : 'bg-blue-600';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-gray-200 rounded-full h-2">
        <div className={`${bg} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 w-10 text-right">{pct}%</span>
    </div>
  );
}

export function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { success, error } = useToast();

  const { data: campaign, isLoading } = useQuery({
    queryKey: ['campaigns', id, 'report'],
    queryFn: () => campaignsApi.report(id!),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'ACTIVE' ? 10_000 : false;
    },
  });

  function action(fn: () => Promise<unknown>, msg: string) {
    return useMutation({
      mutationFn: fn,
      onSuccess: () => { success(msg); void qc.invalidateQueries({ queryKey: ['campaigns', id] }); },
      onError: (e: Error) => error(e.message),
    });
  }

  const pause = action(() => campaignsApi.pause(id!), 'Pausada');
  const resume = action(() => campaignsApi.resume(id!), 'Retomada');
  const cancel = action(() => campaignsApi.cancel(id!), 'Cancelada');

  if (isLoading) return <><Header title="Campanha" /><PageSpinner /></>;
  if (!campaign) return <><Header title="Campanha" /><div className="p-6 text-sm text-gray-500">Campanha não encontrada.</div></>;

  const c = campaign;
  const answerRate = c.completedCount > 0 ? Math.round((c.answeredCount / c.completedCount) * 100) : 0;

  return (
    <>
      <Header
        title={c.name}
        actions={
          <Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => navigate('/campaigns')}>
            Voltar
          </Button>
        }
      />

      <div className="p-6 max-w-3xl space-y-6">
        {/* Status */}
        <Card>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">{c.name}</h2>
              <p className="text-xs text-gray-500 mt-0.5">{c.agent.name}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge className={campaignStatusColor[c.status]}>{campaignStatusLabel(c.status)}</Badge>
              {c.status === 'ACTIVE' && (
                <Button size="sm" variant="ghost" icon={<Pause className="h-3.5 w-3.5" />} loading={pause.isPending} onClick={() => pause.mutate()}>Pausar</Button>
              )}
              {c.status === 'PAUSED' && (
                <Button size="sm" icon={<Play className="h-3.5 w-3.5" />} loading={resume.isPending} onClick={() => resume.mutate()}>Retomar</Button>
              )}
              {['ACTIVE', 'PAUSED'].includes(c.status) && (
                <Button size="sm" variant="danger" icon={<Square className="h-3.5 w-3.5" />} loading={cancel.isPending} onClick={() => { if (confirm('Cancelar campanha?')) cancel.mutate(); }}>
                  Cancelar
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-xs text-gray-500">
              <span>Progresso geral</span>
              <span>{c.completedCount + c.failedCount} / {c.totalContacts}</span>
            </div>
            <ProgressBar value={c.completedCount + c.failedCount} max={c.totalContacts} />
          </div>
        </Card>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'Total', value: c.totalContacts, color: 'text-gray-900' },
            { label: 'Atendidas', value: c.answeredCount, color: 'text-emerald-600' },
            { label: 'Falhadas', value: c.failedCount, color: 'text-red-600' },
            { label: 'Pendentes', value: c.pendingCount, color: 'text-amber-600' },
          ].map((s) => (
            <Card key={s.label} className="text-center">
              <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
              <p className="text-xs text-gray-500 mt-1">{s.label}</p>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Card>
            <p className="text-xs text-gray-500">Taxa de atendimento</p>
            <p className="text-xl font-bold text-gray-900 mt-1">{answerRate}%</p>
            <ProgressBar value={answerRate} max={100} color="emerald" />
          </Card>
          <Card>
            <p className="text-xs text-gray-500">Custo real</p>
            <p className="text-xl font-bold text-gray-900 mt-1">{formatAOA(c.actualCostCents)}</p>
            {c.estimatedCostCents && (
              <p className="text-xs text-gray-400 mt-1">Estimado: {formatAOA(c.estimatedCostCents)}</p>
            )}
          </Card>
        </div>

        {/* AI Summary */}
        {c.summary && (
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <RefreshCw className="h-4 w-4 text-blue-500" />
              <h2 className="text-sm font-semibold text-gray-900">Resumo executivo (IA)</h2>
            </div>
            <p className="text-sm text-gray-700 leading-relaxed">{c.summary}</p>
          </Card>
        )}

        {/* Schedule */}
        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Configurações</h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div>
              <span className="text-gray-500">Janela:</span>{' '}
              <span className="text-gray-900">{String(c.scheduleJson.startHour).padStart(2, '0')}h — {String(c.scheduleJson.endHour).padStart(2, '0')}h</span>
            </div>
            <div>
              <span className="text-gray-500">Ritmo:</span>{' '}
              <span className="text-gray-900">{c.throttlePerMinute} chamadas/min</span>
            </div>
            <div className="col-span-2">
              <span className="text-gray-500">Dias:</span>{' '}
              <span className="text-gray-900">
                {c.scheduleJson.daysOfWeek.map((d) => daysOfWeekLabel()[d]).join(', ')}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Máx. tentativas:</span>{' '}
              <span className="text-gray-900">{c.retryPolicy.maxAttempts}</span>
            </div>
            <div>
              <span className="text-gray-500">Intervalo:</span>{' '}
              <span className="text-gray-900">{c.retryPolicy.delayMinutes} min</span>
            </div>
            {c.startedAt && (
              <div>
                <span className="text-gray-500">Iniciada:</span>{' '}
                <span className="text-gray-900">{formatDate(c.startedAt)}</span>
              </div>
            )}
            {c.completedAt && (
              <div>
                <span className="text-gray-500">Concluída:</span>{' '}
                <span className="text-gray-900">{formatDate(c.completedAt)}</span>
              </div>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
