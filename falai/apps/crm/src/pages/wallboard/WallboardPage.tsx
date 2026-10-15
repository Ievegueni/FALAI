import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Maximize, AlertTriangle, WifiOff } from 'lucide-react';
import { alertsApi, supervisionApi, telephonyApi, type AgentLiveState, type Wallboard } from '@/lib/api';
import { alertText } from '@/components/alerts/alertText';
import { useAuth } from '@/contexts/AuthContext';
import { PageSpinner } from '@/components/ui/Spinner';
import { clsx } from '@/lib/utils';

/**
 * TV da sala de supervisão: ecrã inteiro, letras para ler ao longe, 2 em 2 s.
 * Fica fora do AppLayout de propósito — sem menu e sem o canal SSE, para a
 * conta da sala não contar como "agente ligado" nos relatórios.
 * Nunca mostra números de clientes (a API também não os manda).
 */

const STATE_STYLE: Record<AgentLiveState, string> = {
  AVAILABLE: 'border-emerald-400 bg-emerald-500/15 text-emerald-200',
  IN_CALL: 'border-sky-400 bg-sky-500/15 text-sky-200',
  RINGING: 'border-violet-400 bg-violet-500/20 text-violet-200 animate-pulse',
  WRAP_UP: 'border-amber-400 bg-amber-500/15 text-amber-200',
  PAUSED: 'border-orange-400 bg-orange-500/15 text-orange-200',
  OFFLINE: 'border-slate-700 bg-slate-800/60 text-slate-500',
};
const STATE_ORDER: AgentLiveState[] = ['RINGING', 'IN_CALL', 'WRAP_UP', 'AVAILABLE', 'PAUSED', 'OFFLINE'];

function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const clock = (secs: number) => {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
const since = (iso: string | null, now: number) => (iso ? clock((now - new Date(iso).getTime()) / 1000) : '');

function Tile({ label, value, tone = 'neutral', sub }: { label: string; value: string | number; tone?: 'neutral' | 'good' | 'bad'; sub?: string }) {
  return (
    <div
      className={clsx(
        'rounded-2xl border p-4 lg:p-6',
        tone === 'good' && 'border-emerald-500/50 bg-emerald-500/10',
        tone === 'bad' && 'border-red-500/60 bg-red-500/15',
        tone === 'neutral' && 'border-slate-700 bg-slate-900',
      )}
    >
      <p className="text-sm font-medium uppercase tracking-wide text-slate-400 lg:text-base">{label}</p>
      <p className={clsx('mt-1 text-4xl font-bold tabular-nums lg:text-6xl', tone === 'bad' ? 'text-red-300' : tone === 'good' ? 'text-emerald-300' : 'text-white')}>
        {value}
      </p>
      {sub && <p className="mt-1 text-sm text-slate-400 lg:text-base">{sub}</p>}
    </div>
  );
}

function Board({ data, now }: { data: Wallboard; now: number }) {
  const { t } = useTranslation();
  const k = data.kpis;
  const longest = k.longestWaitSince ? (now - new Date(k.longestWaitSince).getTime()) / 1000 : 0;
  const waitBad = k.waiting > 0 && k.maxWaitTargetSecs !== null && longest > k.maxWaitTargetSecs;
  const slaTone = k.slaPct === null || k.slaTargetPct === null ? 'neutral' : k.slaPct >= k.slaTargetPct ? 'good' : 'bad';
  const agents = [...data.agents].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.name.localeCompare(b.name));
  const count = (s: AgentLiveState) => data.agents.filter((a) => a.state === s).length;

  return (
    <div className="space-y-4 lg:space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6 lg:gap-4">
        <Tile label={t('wallboard.waiting')} value={k.waiting} tone={waitBad ? 'bad' : 'neutral'} sub={k.waiting ? t('wallboard.longest', { time: clock(longest) }) : undefined} />
        <Tile label={t('wallboard.answered')} value={k.answered} />
        <Tile label={t('wallboard.missed')} value={k.missed} tone={k.missed > 0 ? 'bad' : 'neutral'} sub={t('wallboard.abandoned', { n: k.abandoned })} />
        <Tile label={t('wallboard.sla')} value={k.slaPct === null ? '—' : `${k.slaPct}%`} tone={slaTone} sub={k.slaTargetPct !== null ? t('wallboard.target', { pct: k.slaTargetPct }) : undefined} />
        <Tile label={t('wallboard.asa')} value={k.tmeSecs === null ? '—' : clock(k.tmeSecs)} sub={k.tmaSecs !== null ? t('wallboard.tma', { time: clock(k.tmaSecs) }) : undefined} />
        <Tile label={t('wallboard.callbacks')} value={k.pendingCallbacks} />
      </div>

      <div className="grid gap-4 lg:grid-cols-4 lg:gap-6">
        <section className="space-y-3 lg:col-span-3">
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <h2 className="text-xl font-semibold text-white lg:text-2xl">{t('wallboard.agents')}</h2>
            {(['AVAILABLE', 'IN_CALL', 'WRAP_UP', 'PAUSED'] as const).map((s) => (
              <span key={s} className="text-sm text-slate-400 lg:text-base">{t(`supervision.state.${s}`)}: <b className="text-white">{count(s)}</b></span>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {agents.map((a) => (
              <div key={a.extensionId} className={clsx('rounded-xl border-2 p-3 lg:p-4', STATE_STYLE[a.state])}>
                <p className="truncate text-lg font-semibold text-white lg:text-xl">{a.name}</p>
                <div className="mt-1 flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium lg:text-base">
                    {a.state === 'PAUSED' && a.pauseReason ? a.pauseReason : t(`supervision.state.${a.state}`)}
                  </span>
                  <span className="text-lg font-bold tabular-nums lg:text-2xl">{since(a.since, now)}</span>
                </div>
                {a.state === 'IN_CALL' && (a.customer || a.group) && (
                  <p className="mt-1 truncate text-sm text-slate-300">{[a.customer, a.group].filter(Boolean).join(' · ')}</p>
                )}
              </div>
            ))}
            {agents.length === 0 && <p className="col-span-full py-8 text-center text-slate-500">{t('wallboard.noAgents')}</p>}
          </div>
        </section>

        <aside className="space-y-4 lg:space-y-6">
          <section className="rounded-2xl border border-slate-700 bg-slate-900 p-4">
            <h2 className="mb-2 text-xl font-semibold text-white">{t('wallboard.queue')}</h2>
            {data.queue.length === 0 ? (
              <p className="text-slate-500">{t('wallboard.queueEmpty')}</p>
            ) : (
              <ul className="space-y-1.5">
                {data.queue.slice(0, 8).map((q, i) => (
                  <li key={i} className="flex justify-between gap-3 text-base lg:text-lg">
                    <span className="truncate text-slate-200">{q.customer ?? t('wallboard.unknownCustomer')}{q.group && <span className="text-slate-500"> · {q.group}</span>}</span>
                    <span className="font-bold tabular-nums text-white">{since(q.since, now)}</span>
                  </li>
                ))}
                {data.queue.length > 8 && <li className="text-sm text-slate-500">{t('wallboard.more', { n: data.queue.length - 8 })}</li>}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-slate-700 bg-slate-900 p-4">
            <h2 className="mb-2 text-xl font-semibold text-white">{t('wallboard.ranking')}</h2>
            {data.ranking.length === 0 ? (
              <p className="text-slate-500">{t('wallboard.rankingEmpty')}</p>
            ) : (
              <ol className="space-y-1.5">
                {data.ranking.map((r, i) => (
                  <li key={r.extensionId} className="flex items-baseline gap-2 text-base lg:text-lg">
                    <span className={clsx('w-6 shrink-0 text-right font-bold', i === 0 ? 'text-amber-300' : 'text-slate-500')}>{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-200">{r.name}</span>
                    <span className="font-bold tabular-nums text-white">{r.answered}</span>
                    <span className="w-14 text-right text-sm tabular-nums text-slate-400">{r.tmaSecs !== null ? clock(r.tmaSecs) : '—'}</span>
                    {r.csatAvg !== null && <span className="w-10 text-right text-sm text-emerald-300">★{r.csatAvg}</span>}
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-2 text-xs text-slate-500">{t('wallboard.rankingHint')}</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function WallboardPage() {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  const [params, setParams] = useSearchParams();
  const groupId = params.get('group') ?? undefined;
  const now = useNow();
  const { data, error, isError, dataUpdatedAt } = useQuery({
    queryKey: ['wallboard', groupId],
    queryFn: () => supervisionApi.wallboard(groupId),
    refetchInterval: 2000,
    retry: false,
    enabled: !!user,
  });
  const { data: alerts } = useQuery({ queryKey: ['alerts', 'open'], queryFn: () => alertsApi.list({ open: true }), refetchInterval: 10_000, retry: false, enabled: !!user });
  const { data: groups } = useQuery({ queryKey: ['telephony', 'groups'], queryFn: telephonyApi.listGroups, retry: false, enabled: !!user });

  if (loading) return <div className="flex h-screen items-center justify-center bg-slate-950"><PageSpinner /></div>;
  if (!user) return <Navigate to="/login" replace />;

  // Sem resposta há mais de 10 s: os números no ecrã já não são de agora.
  const stale = isError || (dataUpdatedAt > 0 && now - dataUpdatedAt > 10_000);
  const fullscreen = () => void document.documentElement.requestFullscreen?.().catch(() => {});

  return (
    // Com alertas, a faixa fixa em baixo não pode tapar o fim do ranking.
    <div className={clsx('min-h-screen bg-slate-950 p-4 text-slate-100 lg:p-8', !!alerts?.data.length && 'pb-32 lg:pb-32')}>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 lg:mb-6">
        <h1 className="text-2xl font-bold text-white lg:text-3xl">
          {t('wallboard.title')}{data?.group && <span className="text-slate-400"> · {data.group}</span>}
        </h1>
        <div className="flex items-center gap-4">
          {stale && (
            <span className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1 text-sm font-semibold text-white">
              <WifiOff className="h-4 w-4" /> {t('wallboard.offline')}
            </span>
          )}
          {groups && groups.length > 0 && (
            <select
              className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-300"
              value={groupId ?? ''}
              onChange={(e) => setParams(e.target.value ? { group: e.target.value } : {})}
            >
              <option value="">{t('wallboard.allGroups')}</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          <button onClick={fullscreen} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label={t('wallboard.fullscreen')} title={t('wallboard.fullscreen')}>
            <Maximize className="h-5 w-5" />
          </button>
          <span className="text-3xl font-bold tabular-nums text-white lg:text-4xl">
            {new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </header>

      {data ? <Board data={data} now={now} /> : isError ? (
        <p className="py-20 text-center text-xl text-red-300">{(error as Error).message}</p>
      ) : <PageSpinner />}

      {alerts && alerts.data.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 flex flex-wrap items-center gap-x-6 gap-y-1 bg-red-700 px-6 py-3 text-lg font-semibold text-white">
          <AlertTriangle className="h-6 w-6 shrink-0" />
          {alerts.data.slice(0, 4).map((a) => <span key={a.id}>{alertText(t, a)}</span>)}
        </div>
      )}
    </div>
  );
}
