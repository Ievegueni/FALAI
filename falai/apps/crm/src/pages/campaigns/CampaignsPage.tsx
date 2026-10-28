import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Megaphone, Play, Pause, Square, BarChart2, Rocket, RotateCcw, Users, FileText, Clock, Bot } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { campaignsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageSpinner } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/contexts/ToastContext';
import { campaignStatusLabel, campaignStatusColor, formatDate, formatAOA, daysOfWeekLabel } from '@/lib/utils';
import type { Campaign } from '@/types';

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-gray-200 rounded-full h-1.5">
        <div className="bg-blue-600 h-1.5 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 w-8 text-right">{pct}%</span>
    </div>
  );
}

function CampaignCard({ c, onView }: { c: Campaign; onView: (c: Campaign) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { success, error } = useToast();

  function useAction(fn: () => Promise<unknown>, msg: string) {
    return useMutation({
      mutationFn: fn,
      onSuccess: () => { success(msg); void qc.invalidateQueries({ queryKey: ['campaigns'] }); },
      onError: (e: Error) => error(e.message),
    });
  }

  const launch = useAction(() => campaignsApi.launch(c.id), t('campaigns.launched'));
  const pause = useAction(() => campaignsApi.pause(c.id), t('campaigns.paused'));
  const resume = useAction(() => campaignsApi.resume(c.id), t('campaigns.resumed'));
  const cancel = useAction(() => campaignsApi.cancel(c.id), t('campaigns.cancelled'));
  const retry = useAction(() => campaignsApi.retry(c.id), t('campaigns.retried'));

  const answered = c.answeredCount;
  const answerRate = c.completedCount > 0 ? Math.round((answered / c.completedCount) * 100) : 0;

  return (
    <Card className="space-y-3">
      <button
        type="button"
        className="w-full text-left space-y-3 cursor-pointer rounded-lg -m-1 p-1 transition-colors hover:bg-gray-50"
        onClick={() => onView(c)}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">{c.name}</h3>
            <p className="text-xs text-gray-500 mt-0.5">{c.agent?.name ?? '—'} · {formatDate(c.createdAt)}</p>
          </div>
          <Badge className={campaignStatusColor[c.status]}>{campaignStatusLabel(c.status)}</Badge>
        </div>

        <div className="grid grid-cols-4 gap-2 text-center">
          <div>
            <p className="text-lg font-bold text-gray-900">{c.totalContacts}</p>
            <p className="text-xs text-gray-400">{t('campaigns.total')}</p>
          </div>
          <div>
            <p className="text-lg font-bold text-emerald-600">{c.completedCount}</p>
            <p className="text-xs text-gray-400">{t('campaigns.completed')}</p>
          </div>
          <div>
            <p className="text-lg font-bold text-blue-600">{answerRate}%</p>
            <p className="text-xs text-gray-400">{t('campaigns.answerRate')}</p>
          </div>
          <div>
            <p className="text-lg font-bold text-gray-700">{formatAOA(c.actualCostCents)}</p>
            <p className="text-xs text-gray-400">{t('campaigns.cost')}</p>
          </div>
        </div>

        <ProgressBar value={c.completedCount + c.failedCount} max={c.totalContacts} />
      </button>

      <div className="flex items-center gap-2 pt-1 border-t border-gray-100 flex-wrap">
        <Button size="sm" variant="ghost" icon={<BarChart2 className="h-3.5 w-3.5" />} onClick={() => navigate(`/campaigns/${c.id}`)}>
          {t('campaigns.report')}
        </Button>

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
          <Button size="sm" variant="ghost" icon={<Pause className="h-3.5 w-3.5" />} loading={pause.isPending} onClick={() => pause.mutate()}>
            {t('campaigns.pause')}
          </Button>
        )}
        {['DRAFT', 'ACTIVE', 'PAUSED'].includes(c.status) && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Square className="h-3.5 w-3.5 text-red-500" />}
            loading={cancel.isPending}
            onClick={() => { if (confirm(t('campaigns.cancelConfirm'))) cancel.mutate(); }}
          >
            <span className="text-red-500">{t('campaigns.cancel')}</span>
          </Button>
        )}
        {['CANCELLED', 'COMPLETED'].includes(c.status) && (
          <Button
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 text-white border-0"
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            loading={retry.isPending}
            onClick={() => retry.mutate()}
          >
            {t('campaigns.retry')}
          </Button>
        )}
      </div>
    </Card>
  );
}

function CampaignQuickViewModal({ c, onClose }: { c: Campaign; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const window =
    c.scheduleJson.mode === 'NOW'
      ? t('campaigns.form.scheduleNow')
      : `${String(c.scheduleJson.startHour).padStart(2, '0')}h — ${String(c.scheduleJson.endHour).padStart(2, '0')}h`;

  return (
    <Modal open onClose={onClose} title={c.name} size="lg">
      <div className="space-y-5">
        <div className="flex items-center gap-2">
          <Badge className={campaignStatusColor[c.status]}>{campaignStatusLabel(c.status)}</Badge>
          <span className="text-xs text-gray-500">{c.agent?.name ?? '—'} · {formatDate(c.createdAt)}</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Card className="text-center">
            <Users className="h-4 w-4 text-gray-400 mx-auto mb-1" />
            <p className="text-xl font-bold text-gray-900">{c.totalContacts}</p>
            <p className="text-xs text-gray-500">{t('campaigns.quickView.numbers')}</p>
          </Card>
          <Card className="text-center">
            <Clock className="h-4 w-4 text-gray-400 mx-auto mb-1" />
            <p className="text-sm font-bold text-gray-900 mt-1">{window}</p>
            <p className="text-xs text-gray-500">{t('campaigns.detail.windowLabel')}</p>
          </Card>
          <Card className="text-center">
            <p className="text-xl font-bold text-gray-700">{formatAOA(c.actualCostCents)}</p>
            <p className="text-xs text-gray-500 mt-1">{t('campaigns.cost')}</p>
          </Card>
        </div>

        {(c.startedAt || c.completedAt) && (
          <div className="grid grid-cols-2 gap-3 text-sm">
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
        )}

        {c.scheduleJson.mode !== 'NOW' && (
          <div className="text-sm">
            <span className="text-gray-500">{t('campaigns.detail.daysLabel')}</span>{' '}
            <span className="text-gray-900">
              {c.scheduleJson.daysOfWeek.map((d) => daysOfWeekLabel()[d]).join(', ')}
            </span>
          </div>
        )}

        <div>
          <div className="flex items-center gap-2 mb-2">
            <FileText className="h-4 w-4 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-900">{t('campaigns.quickView.script')}</h3>
          </div>
          {c.mode === 'FIXED_SCRIPT' && c.scriptText ? (
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap bg-gray-50 rounded-lg p-3">
              {c.scriptText}
            </p>
          ) : (
            <p className="text-sm text-gray-500 flex items-center gap-2 bg-gray-50 rounded-lg p-3">
              <Bot className="h-4 w-4 text-gray-400 shrink-0" />
              {t('campaigns.quickView.scriptAiDriven', { agent: c.agent?.name ?? '—' })}
            </p>
          )}
        </div>

        <div className="flex justify-end pt-2 border-t border-gray-100">
          <Button size="sm" variant="ghost" icon={<BarChart2 className="h-3.5 w-3.5" />} onClick={() => navigate(`/campaigns/${c.id}`)}>
            {t('campaigns.quickView.fullReport')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function CampaignsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Campaign | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['campaigns', page],
    queryFn: () => campaignsApi.list({ page }),
    refetchInterval: 15_000,
  });

  return (
    <>
      <Header
        title={t('campaigns.title')}
        actions={
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate('/campaigns/new')}>
            {t('campaigns.new')}
          </Button>
        }
      />

      <div className="p-6 space-y-4">
        {isLoading ? (
          <PageSpinner />
        ) : data?.data.length === 0 ? (
          <EmptyState
            icon={<Megaphone className="h-8 w-8" />}
            title={t('campaigns.emptyTitle')}
            description={t('campaigns.emptyDescription')}
            action={{ label: t('campaigns.new'), icon: <Plus className="h-4 w-4" />, onClick: () => navigate('/campaigns/new') }}
          />
        ) : (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {data?.data.map((c) => <CampaignCard key={c.id} c={c} onView={setSelected} />)}
            </div>
            {data && <Pagination page={page} total={data.total} perPage={data.perPage} onPage={setPage} />}
          </>
        )}
      </div>

      {selected && <CampaignQuickViewModal c={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
