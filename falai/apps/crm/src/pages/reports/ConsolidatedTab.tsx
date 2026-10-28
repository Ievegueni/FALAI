import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Inbox, PhoneIncoming, Smile, Target, Ticket, ClipboardCheck, MessageSquare, Clock, AlarmClock, MessageSquareText } from 'lucide-react';
import { consolidatedApi, type ConsolidatedBucket } from '@/lib/api';
import { Card, StatCard } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { clsx, formatDuration } from '@/lib/utils';

const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
const dur = (v: number | null) => (v === null ? '—' : formatDuration(v));
/** Verde se cumpre a meta, vermelho se não; sem meta, sem cor. */
const tone = (v: number | null, target: number | null) => (v === null || target === null ? undefined : v >= target ? 'text-emerald-700' : 'text-red-600');
const withTarget = (hint: string, target: number | null, targetLabel: string) => (target === null ? hint : `${hint} · ${targetLabel} ${target}%`);

/** Painel de direcção: chamadas + conversas + tickets, por canal e por período (fase 9). */
export function ConsolidatedTab({ from, to, bucket, onBucket }: { from: string; to: string; bucket: ConsolidatedBucket; onBucket: (b: ConsolidatedBucket) => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({ queryKey: ['reports', 'consolidated', from, to, bucket], queryFn: () => consolidatedApi.get({ from, to, bucket }) });
  if (isLoading || !data) return <PageSpinner />;
  const k = data.kpis;
  const tg = data.targets;
  const maxChannel = Math.max(1, ...data.byChannel.map((c) => c.contacts));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t('reports.cons.contacts')} value={k.contacts} sub={t('reports.cons.contactsHint')} icon={<Inbox className="h-5 w-5" />} />
        <StatCard label={t('reports.cons.callsIn')} value={k.calls.total} sub={t('reports.cons.answeredPct', { pct: pct(k.calls.answerRate) })} icon={<PhoneIncoming className="h-5 w-5" />} />
        <StatCard label={t('reports.cons.slaVoice')} value={<span className={tone(k.calls.slaPct, tg.slaTargetPct)}>{pct(k.calls.slaPct)}</span>} sub={withTarget(t('reports.att.slaHint', { secs: k.slaSecs }), tg.slaTargetPct, t('reports.att.target'))} icon={<Target className="h-5 w-5" />} />
        <StatCard label={t('reports.att.tme')} value={dur(k.calls.tmeSecs)} sub={`${t('reports.att.asaP90')} ${dur(k.calls.asaP90Secs)} · ${t('reports.att.tma')} ${dur(k.calls.tmaSecs)}`} icon={<Clock className="h-5 w-5" />} />
        <StatCard label={t('reports.cons.conversations')} value={k.conversations} sub={t('reports.cons.firstResponse', { value: dur(k.textFirstResponseSecs) })} icon={<MessageSquare className="h-5 w-5" />} />
        <StatCard label={t('reports.cons.slaText')} value={<span className={tone(k.textSla.slaPct, tg.textSlaTargetPct)}>{pct(k.textSla.slaPct)}</span>} sub={withTarget(t('reports.cons.slaTextHint', { min: Math.round(tg.textSlaSecs / 60) }), tg.textSlaTargetPct, t('reports.att.target'))} icon={<MessageSquareText className="h-5 w-5" />} />
        <StatCard label={t('reports.cons.tickets')} value={k.ticketsCreated} sub={t('reports.cons.ticketsHint', { resolved: k.ticketsResolved, time: dur(k.ticketResolutionSecs) })} icon={<Ticket className="h-5 w-5" />} />
        <StatCard label={t('reports.cons.slaTickets')} value={<span className={tone(k.ticketSla.slaPct, tg.ticketSlaTargetPct)}>{pct(k.ticketSla.slaPct)}</span>} sub={withTarget(t('reports.cons.slaTicketsHint', { breached: k.ticketSla.breached }), tg.ticketSlaTargetPct, t('reports.att.target'))} icon={<Target className="h-5 w-5" />} />
        <StatCard label={t('reports.cons.overdueNow')} value={<span className={k.ticketsOverdueNow ? 'text-red-600' : undefined}>{k.ticketsOverdueNow}</span>} sub={t('reports.cons.overdueNowHint')} icon={<AlarmClock className="h-5 w-5" />} />
        <StatCard label={t('reports.csat.avg')} value={k.csat.avg ?? '—'} sub={t('reports.cons.csatHint', { pct: pct(k.csat.satisfiedPct), n: k.csat.responses })} icon={<Smile className="h-5 w-5" />} />
        <StatCard label={t('reports.cons.qa')} value={k.qa.avgScore ?? '—'} sub={t('reports.cons.qaHint', { n: k.qa.evaluations })} icon={<ClipboardCheck className="h-5 w-5" />} />
      </div>

      <Card padding={false} className="overflow-x-auto">
        <h3 className="px-4 pt-3 text-sm font-semibold text-gray-900">{t('reports.cons.byChannel')}</h3>
        {data.byChannel.length === 0 ? <p className="px-4 py-3 text-sm text-gray-400">—</p> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">{t('reports.cons.channelCol')}</th>
                <th className="px-4 py-2 font-medium" />
                <th className="px-4 py-2 text-right font-medium">{t('reports.cons.contacts')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('reports.cons.firstResponseCol')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('reports.att.sla')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.byChannel.map((c) => {
                const target = c.channel === 'VOICE' ? tg.slaTargetPct : tg.textSlaTargetPct;
                return (
                  <tr key={c.channel} className="tabular-nums">
                    <td className="w-32 px-4 py-2 text-gray-700">{t(`reports.cons.channel.${c.channel}`, { defaultValue: c.channel })}</td>
                    <td className="px-4 py-2"><div className="h-2.5 rounded bg-gray-100"><div className="h-2.5 rounded bg-blue-500" style={{ width: `${(c.contacts / maxChannel) * 100}%` }} /></div></td>
                    <td className="px-4 py-2 text-right text-gray-700">{c.contacts}</td>
                    <td className="px-4 py-2 text-right text-gray-700">{dur(c.firstResponseSecs)}</td>
                    <td className={clsx('px-4 py-2 text-right font-medium', tone(c.slaPct, target))}>{pct(c.slaPct)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {k.ticketsCreated > 0 && (
        <Card padding={false} className="overflow-x-auto">
          <h3 className="px-4 pt-3 text-sm font-semibold text-gray-900">{t('reports.cons.byPriority')}</h3>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500">
              <tr>{['priority', 'targetHours', 'created', 'met', 'breached', 'open', 'sla', 'resolution'].map((c) => (
                <th key={c} className={clsx('px-4 py-2 font-medium', c !== 'priority' && 'text-right')}>{t(`reports.cons.prio.${c}`)}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.ticketsByPriority.filter((p) => p.created > 0).map((p) => (
                <tr key={p.priority} className="tabular-nums">
                  <td className="px-4 py-2 text-gray-900">{t(`tickets.priority.${p.priority}`)}</td>
                  <td className="px-4 py-2 text-right text-gray-700">{p.targetHours === null ? '—' : `${p.targetHours} h`}</td>
                  <td className="px-4 py-2 text-right text-gray-700">{p.created}</td>
                  <td className="px-4 py-2 text-right text-gray-700">{p.met}</td>
                  <td className="px-4 py-2 text-right text-gray-700">{p.breached}</td>
                  <td className="px-4 py-2 text-right text-gray-700">{p.open}</td>
                  <td className={clsx('px-4 py-2 text-right font-medium', tone(p.slaPct, tg.ticketSlaTargetPct))}>{pct(p.slaPct)}</td>
                  <td className="px-4 py-2 text-right text-gray-700">{dur(p.resolutionSecs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card padding={false} className="overflow-x-auto">
        <div className="flex items-center justify-between px-4 pt-3">
          <h3 className="text-sm font-semibold text-gray-900">{t('reports.cons.series')}</h3>
          <select className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm" value={bucket} onChange={(e) => onBucket(e.target.value as ConsolidatedBucket)}>
            {(['day', 'week', 'month'] as const).map((b) => <option key={b} value={b}>{t(`reports.cons.bucket.${b}`)}</option>)}
          </select>
        </div>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-gray-500">
            <tr>{['period', 'callsIn', 'callsAnswered', 'callsMissed', 'callsSlaPct', 'callsOut', 'conversations', 'conversationsResolved', 'textSlaPct', 'ticketsCreated', 'ticketsResolved', 'ticketsBreached', 'ticketSlaPct'].map((c) => (
              <th key={c} className="px-4 py-2 font-medium">{t(`reports.cons.col.${c}`)}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {data.series.map((r) => (
              <tr key={r.period} className="tabular-nums">
                <td className="px-4 py-2 text-gray-900">{r.period}</td>
                <td className="px-4 py-2">{r.callsIn}</td>
                <td className="px-4 py-2">{r.callsAnswered}</td>
                <td className="px-4 py-2">{r.callsMissed}</td>
                <td className={clsx('px-4 py-2', tone(r.callsSlaPct, tg.slaTargetPct))}>{pct(r.callsSlaPct)}</td>
                <td className="px-4 py-2">{r.callsOut}</td>
                <td className="px-4 py-2">{r.conversations}</td>
                <td className="px-4 py-2">{r.conversationsResolved}</td>
                <td className={clsx('px-4 py-2', tone(r.textSlaPct, tg.textSlaTargetPct))}>{pct(r.textSlaPct)}</td>
                <td className="px-4 py-2">{r.ticketsCreated}</td>
                <td className="px-4 py-2">{r.ticketsResolved}</td>
                <td className="px-4 py-2">{r.ticketsBreached}</td>
                <td className={clsx('px-4 py-2', tone(r.ticketSlaPct, tg.ticketSlaTargetPct))}>{pct(r.ticketSlaPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
