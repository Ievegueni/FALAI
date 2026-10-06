import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Play, Pause, Square, RefreshCw, Rocket, RotateCcw } from 'lucide-react';
import { campaignsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import { CampaignContactsTable } from './CampaignContactsTable';
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
  const { t } = useTranslation();
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

  function useAction(fn: () => Promise<unknown>, msg: string) {
    return useMutation({
      mutationFn: fn,
      onSuccess: () => { success(msg); void qc.invalidateQueries({ queryKey: ['campaigns', id] }); },
      onError: (e: Error) => error(e.message),
    });
  }

  const launch = useAction(() => campaignsApi.launch(id!), t('campaigns.launched'));
  const pause = useAction(() => campaignsApi.pause(id!), t('campaigns.detail.pausedShort'));
  const resume = useAction(() => campaignsApi.resume(id!), t('campaigns.detail.resumedShort'));
  const cancel = useAction(() => campaignsApi.cancel(id!), t('campaigns.detail.cancelledShort'));
  const retry = useAction(() => campaignsApi.retry(id!, 'ALL'), t('campaigns.retried'));
  // Repetir só quem falhou evita voltar a ligar a quem já atendeu.
  const retryFailed = useAction(() => campaignsApi.retry(id!, 'FAILED'), t('campaigns.retried'));

  if (isLoading) return <><Header title={t('campaigns.campaignTitle')} /><PageSpinner /></>;
  if (!campaign) return <><Header title={t('campaigns.campaignTitle')} /><div className="p-6 text-sm text-gray-500">{t('campaigns.notFound')}</div></>;

  const c = campaign;
  // Taxa medida sobre quem foi realmente contactado — cancelados e opt-outs
  // não entram na base, senão cancelar uma campanha afundava a taxa.
  const answerRate = c.attemptedCount > 0 ? Math.round((c.answeredCount / c.attemptedCount) * 100) : 0;

  return (
    <>
      <Header
        title={c.name}
        actions={
          <Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => navigate('/campaigns')}>
            {t('common.back')}
          </Button>
        }
      />

      <div className="p-6 max-w-5xl space-y-6">
        {/* Status */}
        <Card>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">{c.name}</h2>
              <p className="text-xs text-gray-500 mt-0.5">{c.agent?.name ?? '—'}</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className={campaignStatusColor[c.status]}>{campaignStatusLabel(c.status)}</Badge>
              {(c.status === 'DRAFT' || c.status === 'PAUSED') && (
                <Button
                  size="sm"
                  className="bg-emerald-600 hover:bg-emerald-700 text-white border-0"
                  icon={<Rocket className="h-3.5 w-3.5" />}
                  loading={launch.isPending}
                  onClick={() => launch.mutate()}
                >
                  {t('campaigns.launch')}
                </Button>
              )}
              {c.status === 'ACTIVE' && (
                <Button size="sm" variant="ghost" icon={<Pause className="h-3.5 w-3.5" />} loading={pause.isPending} onClick={() => pause.mutate()}>{t('campaigns.pause')}</Button>
              )}
              {['DRAFT', 'ACTIVE', 'PAUSED'].includes(c.status) && (
                <Button size="sm" variant="danger" icon={<Square className="h-3.5 w-3.5" />} loading={cancel.isPending} onClick={() => { if (confirm(t('campaigns.detail.cancelConfirm'))) cancel.mutate(); }}>
                  {t('campaigns.cancel')}
                </Button>
              )}
              {['CANCELLED', 'COMPLETED'].includes(c.status) && (
                <>
                  {c.failedCount + c.skippedCount > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<RotateCcw className="h-3.5 w-3.5" />}
                      loading={retryFailed.isPending}
                      onClick={() => retryFailed.mutate()}
                    >
                      {t('campaigns.retryFailed')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    className="bg-blue-600 hover:bg-blue-700 text-white border-0"
                    icon={<RotateCcw className="h-3.5 w-3.5" />}
                    loading={retry.isPending}
                    onClick={() => { if (confirm(t('campaigns.retryAllConfirm'))) retry.mutate(); }}
                  >
                    {t('campaigns.retry')}
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-xs text-gray-500">
              <span>{t('campaigns.detail.overallProgress')}</span>
              <span>{c.completedCount + c.failedCount} / {c.totalContacts}</span>
            </div>
            <ProgressBar value={c.completedCount + c.failedCount} max={c.totalContacts} />
          </div>
        </Card>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: t('campaigns.detail.total'), value: c.totalContacts, color: 'text-gray-900' },
            { label: t('campaigns.detail.answered'), value: c.answeredCount, color: 'text-emerald-600' },
            { label: t('campaigns.detail.failed'), value: c.failedCount, color: 'text-red-600' },
            { label: t('campaigns.detail.pending'), value: c.pendingCount, color: 'text-amber-600' },
            // Só aparecem quando existem — não poluem o ecrã do caso normal.
            ...(c.skippedCount > 0
              ? [{ label: t('campaigns.detail.skipped'), value: c.skippedCount, color: 'text-gray-500' }]
              : []),
            ...(c.optedOutCount > 0
              ? [{ label: t('campaigns.detail.optedOut'), value: c.optedOutCount, color: 'text-purple-600' }]
              : []),
          ].map((s) => (
            <Card key={s.label} className="text-center">
              <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
              <p className="text-xs text-gray-500 mt-1">{s.label}</p>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Card>
            <p className="text-xs text-gray-500">{t('campaigns.detail.answerRateLabel')}</p>
            <p className="text-xl font-bold text-gray-900 mt-1">{answerRate}%</p>
            <ProgressBar value={answerRate} max={100} color="emerald" />
          </Card>
          <Card>
            <p className="text-xs text-gray-500">{t('campaigns.detail.actualCost')}</p>
            <p className="text-xl font-bold text-gray-900 mt-1">{formatAOA(c.actualCostCents)}</p>
            {c.estimatedCostCents && (
              <p className="text-xs text-gray-400 mt-1">{t('campaigns.detail.estimated')}: {formatAOA(c.estimatedCostCents)}</p>
            )}
          </Card>
        </div>

        {/* Participantes — quem atendeu, quem falhou e porquê */}
        <CampaignContactsTable campaignId={c.id} campaignName={c.name} />

        {/* AI Summary */}
        {c.summary && (
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <RefreshCw className="h-4 w-4 text-blue-500" />
              <h2 className="text-sm font-semibold text-gray-900">{t('campaigns.detail.aiSummary')}</h2>
            </div>
            <p className="text-sm text-gray-700 leading-relaxed">{c.summary}</p>
          </Card>
        )}

        {/* Schedule */}
        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-3">{t('campaigns.detail.settings')}</h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div>
              <span className="text-gray-500">{t('campaigns.detail.windowLabel')}</span>{' '}
              <span className="text-gray-900">
                {c.scheduleJson.mode === 'NOW'
                  ? t('campaigns.form.scheduleNow')
                  : `${String(c.scheduleJson.startHour).padStart(2, '0')}h — ${String(c.scheduleJson.endHour).padStart(2, '0')}h`}
              </span>
            </div>
            <div>
              <span className="text-gray-500">{t('campaigns.detail.rateLabel')}</span>{' '}
              <span className="text-gray-900">{t('campaigns.detail.callsPerMinUnit', { n: c.throttlePerMinute })}</span>
            </div>
            {c.scheduleJson.mode !== 'NOW' && (
              <div className="col-span-2">
                <span className="text-gray-500">{t('campaigns.detail.daysLabel')}</span>{' '}
                <span className="text-gray-900">
                  {c.scheduleJson.daysOfWeek.map((d) => daysOfWeekLabel()[d]).join(', ')}
                </span>
              </div>
            )}
            <div>
              <span className="text-gray-500">{t('campaigns.detail.maxAttemptsLabel')}</span>{' '}
              <span className="text-gray-900">{c.retryPolicy.maxAttempts}</span>
            </div>
            <div>
              <span className="text-gray-500">{t('campaigns.detail.intervalLabel')}</span>{' '}
              <span className="text-gray-900">{t('campaigns.detail.minUnit', { n: c.retryPolicy.delayMinutes })}</span>
            </div>
            {c.startedAt && (
              <div>
                <span className="text-gray-500">{t('campaigns.detail.startedLabel')}</span>{' '}
                <span className="text-gray-900">{formatDate(c.startedAt)}</span>
              </div>
            )}
            {c.completedAt && (
              <div>
                <span className="text-gray-500">{t('campaigns.detail.completedLabel')}</span>{' '}
                <span className="text-gray-900">{formatDate(c.completedAt)}</span>
              </div>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
