import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Headphones, MessageCircle, Users, PhoneOff, Clock, PhoneMissed, ListOrdered, CheckCircle, Upload } from 'lucide-react';
import {
  supervisionApi,
  type AgentLiveState,
  type SupervisionLive,
  type SupervisionMode,
} from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Header } from '@/components/layout/Header';
import { Card, StatCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import { Pagination } from '@/components/ui/Pagination';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import { toTelephonyWav } from '@/lib/telephonyWav';
import { clsx, formatDuration, formatPhone } from '@/lib/utils';
import { isOpsManager } from '@/lib/roles';
import { AlertsHistory, OpenAlerts, TargetsCard } from './AlertsPanels';

/**
 * Supervisão em tempo real (melhoria 4). O painel pergunta à API de 2 em 2 s
 * (com as permissões de quem pergunta) e os contadores andam ao segundo aqui.
 * O áudio chega à extensão do supervisor — o webphone atende sozinho.
 */

function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const elapsed = (since: string | null, now: number) =>
  since ? formatDuration(Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000))) : '—';

const STATE_CLASS: Record<AgentLiveState, string> = {
  IN_CALL: 'bg-blue-50 text-blue-700',
  RINGING: 'bg-amber-50 text-amber-700',
  WRAP_UP: 'bg-purple-50 text-purple-700',
  PAUSED: 'bg-gray-200 text-gray-700',
  AVAILABLE: 'bg-emerald-50 text-emerald-700',
  OFFLINE: 'bg-gray-100 text-gray-400',
};

const MODES: { mode: SupervisionMode; icon: typeof Headphones }[] = [
  { mode: 'LISTEN', icon: Headphones },
  { mode: 'WHISPER', icon: MessageCircle },
  { mode: 'BARGE', icon: Users },
];

function Live() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { error } = useToast();
  const now = useNow();
  const { data, isLoading } = useQuery({ queryKey: ['supervision', 'live'], queryFn: supervisionApi.live, refetchInterval: 2000 });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['supervision', 'live'] });

  const start = useMutation({
    mutationFn: ({ callId, mode }: { callId: string; mode: SupervisionMode }) => supervisionApi.start(callId, mode),
    onSuccess: refresh,
    onError: (e: Error) => error(e.message),
  });
  const setMode = useMutation({
    mutationFn: ({ sessionId, mode }: { sessionId: string; mode: SupervisionMode }) => supervisionApi.setMode(sessionId, mode),
    onSuccess: refresh,
    onError: (e: Error) => error(e.message),
  });
  const end = useMutation({
    mutationFn: (sessionId: string) => supervisionApi.end(sessionId),
    onSuccess: refresh,
    onError: (e: Error) => error(e.message),
  });

  if (isLoading || !data) return <PageSpinner />;
  const busy = start.isPending || setMode.isPending || end.isPending;

  const actions = (c: SupervisionLive['calls'][number]) => {
    if (c.ownCall) return <span className="text-xs text-gray-400">{t('supervision.ownCall')}</span>;
    const s = c.supervision;
    if (s && !s.mine) {
      return (
        <span className="flex items-center gap-2 text-xs text-gray-500">
          {t('supervision.byOther')}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => end.mutate(s.sessionId)}>{t('supervision.end')}</Button>
        </span>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-1">
        {MODES.map(({ mode, icon: Icon }) => (
          <Button
            key={mode}
            size="sm"
            variant={s?.mode === mode ? 'primary' : 'outline'}
            icon={<Icon className="h-3.5 w-3.5" />}
            disabled={busy || s?.mode === mode}
            onClick={() => (s ? setMode.mutate({ sessionId: s.sessionId, mode }) : start.mutate({ callId: c.callId, mode }))}
          >
            {t(`supervision.mode.${mode}`)}
          </Button>
        ))}
        {s && (
          <Button size="sm" variant="danger" icon={<PhoneOff className="h-3.5 w-3.5" />} disabled={busy} onClick={() => end.mutate(s.sessionId)}>
            {t('supervision.end')}
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t('supervision.kpi.queued')} value={data.kpis.queued} icon={<ListOrdered className="h-5 w-5" />} />
        <StatCard label={t('supervision.kpi.tme')} value={data.kpis.tmeSecs === null ? '—' : formatDuration(data.kpis.tmeSecs)} icon={<Clock className="h-5 w-5" />} />
        <StatCard label={t('supervision.kpi.answered')} value={data.kpis.answered} icon={<CheckCircle className="h-5 w-5" />} />
        <StatCard label={t('supervision.kpi.missed')} value={data.kpis.missed} icon={<PhoneMissed className="h-5 w-5" />} />
      </div>

      <Card padding={false} className="overflow-x-auto">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">{t('supervision.activeCalls', { count: data.calls.length })}</h2>
          <p className="text-xs text-gray-500">{t('supervision.audioHint')}</p>
        </div>
        {data.calls.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">{t('supervision.noCalls')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">{t('supervision.agent')}</th>
                <th className="px-4 py-2.5 font-medium">{t('supervision.group')}</th>
                <th className="px-4 py-2.5 font-medium">{t('supervision.customer')}</th>
                <th className="px-4 py-2.5 font-medium text-right">{t('supervision.duration')}</th>
                <th className="px-4 py-2.5 font-medium">{t('supervision.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.calls.map((c) => (
                <tr key={c.callId}>
                  <td className="px-4 py-2.5 text-gray-900">{c.agent ?? '—'} <span className="text-gray-400">{c.agentNumber}</span></td>
                  <td className="px-4 py-2.5 text-gray-700">{c.group ?? '—'}</td>
                  <td className="px-4 py-2.5 text-gray-700">{c.customer ?? formatPhone(c.number)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-gray-700">{elapsed(c.since, now)}</td>
                  <td className="px-4 py-2.5">
                    {c.supervision?.mine && c.supervision.status === 'CONNECTING' && (
                      <p className="mb-1 text-xs text-amber-700">{t('supervision.connecting')}</p>
                    )}
                    {actions(c)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card padding={false} className="overflow-x-auto">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">{t('supervision.agents', { count: data.agents.length })}</h2>
        </div>
        <div className="grid grid-cols-1 divide-y divide-gray-50 sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-3">
          {data.agents.map((a) => (
            <div key={a.extensionId} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-900">{a.name ?? a.number}</p>
                <p className="text-xs text-gray-400">{a.number}</p>
              </div>
              <Badge className={STATE_CLASS[a.state]}>{t(`supervision.state.${a.state}`)}</Badge>
              <span className="w-14 text-right text-xs tabular-nums text-gray-500">{elapsed(a.since, now)}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Log() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['supervision', 'log', from, to, page],
    queryFn: () => supervisionApi.log({ ...(from && { from }), ...(to && { to }), page }),
  });
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">{t('reports.from')}</label>
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">{t('reports.to')}</label>
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <p className="text-xs text-gray-500">{t('supervision.logHint')}</p>
      </Card>
      {isLoading || !data ? (
        <PageSpinner />
      ) : data.total === 0 ? (
        <Card><p className="py-6 text-center text-sm text-gray-400">{t('supervision.logEmpty')}</p></Card>
      ) : (
        <Card padding={false} className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">{t('supervision.started')}</th>
                <th className="px-4 py-2.5 font-medium">{t('supervision.supervisor')}</th>
                <th className="px-4 py-2.5 font-medium">{t('supervision.agent')}</th>
                <th className="px-4 py-2.5 font-medium">{t('supervision.customer')}</th>
                <th className="px-4 py-2.5 font-medium">{t('supervision.modes')}</th>
                <th className="px-4 py-2.5 font-medium">{t('supervision.ended')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.data.map((r) => (
                <tr key={r.sessionId}>
                  <td className="px-4 py-2.5 text-gray-700">{new Date(r.startedAt).toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-gray-900">{r.supervisor}</td>
                  <td className="px-4 py-2.5 text-gray-700">{r.agent ?? '—'}</td>
                  <td className="px-4 py-2.5 text-gray-700">{r.customer ?? '—'}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-600">
                    {r.modes.map((m) => `${t(`supervision.mode.${m.mode}`)} ${new Date(m.at).toLocaleTimeString()}`).join(' → ')}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-600">
                    {r.endedAt ? new Date(r.endedAt).toLocaleTimeString() : t('supervision.ongoing')}
                    {r.endReason && <span className="text-gray-400"> · {t(`supervision.endReason.${r.endReason}`, { defaultValue: r.endReason })}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-4 py-3">
            <Pagination page={page} total={data.total} perPage={data.pageSize} onPage={setPage} />
          </div>
        </Card>
      )}
    </div>
  );
}

function Settings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const { data } = useQuery({ queryKey: ['supervision', 'settings'], queryFn: supervisionApi.settings });
  const save = useMutation({
    mutationFn: supervisionApi.updateSettings,
    onSuccess: (d) => { success(t('common.saved')); qc.setQueryData(['supervision', 'settings'], d); },
    onError: (e: Error) => error(e.message),
  });
  const upload = useMutation({
    mutationFn: async (file: File) => supervisionApi.uploadNotice(await toTelephonyWav(file)),
    onSuccess: () => { success(t('supervision.noticeUploaded')); void qc.invalidateQueries({ queryKey: ['supervision', 'settings'] }); },
    onError: (e: Error) => error(e.message),
  });
  if (!data) return <PageSpinner />;
  return (
    <div className="max-w-2xl space-y-4">
      <Card className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={data.supervisionNotifyListen} onChange={(e) => save.mutate({ supervisionNotifyListen: e.target.checked })} />
          {t('supervision.notifyListen')}
        </label>
        <p className="text-xs text-gray-500">{t('supervision.notifyListenHint')}</p>
      </Card>
      <Card className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={data.monitoringNotice} onChange={(e) => save.mutate({ monitoringNotice: e.target.checked })} />
          {t('supervision.monitoringNotice')}
        </label>
        <p className="text-xs text-gray-500">{t('supervision.monitoringNoticeHint')}</p>
        <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
        <Button size="sm" variant="outline" icon={<Upload className="h-4 w-4" />} loading={upload.isPending} onClick={() => fileRef.current?.click()}>
          {t('supervision.uploadNotice')}
        </Button>
      </Card>
    </div>
  );
}

export function SupervisionPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isAdmin = isOpsManager(user?.role);
  const [tab, setTab] = useState('live');
  return (
    <>
      <Header title={t('nav.supervision')} />
      <div className={clsx('p-6 space-y-6')}>
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'live', label: t('supervision.tabLive') },
            { key: 'alerts', label: t('alerts.tab') },
            ...(isAdmin
              ? [
                  { key: 'log', label: t('supervision.tabLog') },
                  { key: 'settings', label: t('supervision.tabSettings') },
                ]
              : []),
          ]}
        />
        {tab === 'live' && <><OpenAlerts /><Live /></>}
        {tab === 'alerts' && <AlertsHistory />}
        {tab === 'log' && isAdmin && <Log />}
        {tab === 'settings' && isAdmin && <><TargetsCard /><Settings /></>}
      </div>
    </>
  );
}
