import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Inbox, PhoneIncoming, Smile, Target, Ticket, ClipboardCheck, MessageSquare, Clock } from 'lucide-react';
import { consolidatedApi, type ConsolidatedBucket } from '@/lib/api';
import { Card, StatCard } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { formatDuration } from '@/lib/utils';

const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
const dur = (v: number | null) => (v === null ? '—' : formatDuration(v));

/** Painel de direcção: chamadas + conversas + tickets, por canal e por período (fase 9). */
export function ConsolidatedTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const [bucket, setBucket] = useState<ConsolidatedBucket>('day');
  const { data, isLoading } = useQuery({ queryKey: ['reports', 'consolidated', from, to, bucket], queryFn: () => consolidatedApi.get({ from, to, bucket }) });
  if (isLoading || !data) return <PageSpinner />;
  const k = data.kpis;
  const maxChannel = Math.max(1, ...data.byChannel.map((c) => c.contacts));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t('reports.cons.contacts')} value={k.contacts} sub={t('reports.cons.contactsHint')} icon={<Inbox className="h-5 w-5" />} />
        <StatCard label={t('reports.cons.callsIn')} value={k.calls.total} sub={t('reports.cons.answeredPct', { pct: pct(k.calls.answerRate) })} icon={<PhoneIncoming className="h-5 w-5" />} />
        <StatCard label={t('reports.att.sla')} value={pct(k.calls.slaPct)} sub={t('reports.att.slaHint', { secs: k.slaSecs })} icon={<Target className="h-5 w-5" />} />
        <StatCard label={t('reports.att.tme')} value={dur(k.calls.tmeSecs)} sub={`${t('reports.att.tma')} ${dur(k.calls.tmaSecs)}`} icon={<Clock className="h-5 w-5" />} />
        <StatCard label={t('reports.cons.conversations')} value={k.conversations} sub={t('reports.cons.firstResponse', { value: dur(k.textFirstResponseSecs) })} icon={<MessageSquare className="h-5 w-5" />} />
        <StatCard label={t('reports.cons.tickets')} value={k.ticketsCreated} sub={t('reports.cons.ticketsHint', { resolved: k.ticketsResolved, time: dur(k.ticketResolutionSecs) })} icon={<Ticket className="h-5 w-5" />} />
        <StatCard label={t('reports.csat.avg')} value={k.csat.avg ?? '—'} sub={t('reports.cons.csatHint', { pct: pct(k.csat.satisfiedPct), n: k.csat.responses })} icon={<Smile className="h-5 w-5" />} />
        <StatCard label={t('reports.cons.qa')} value={k.qa.avgScore ?? '—'} sub={t('reports.cons.qaHint', { n: k.qa.evaluations })} icon={<ClipboardCheck className="h-5 w-5" />} />
      </div>

      <Card>
        <h3 className="mb-3 text-sm font-semibold text-gray-900">{t('reports.cons.byChannel')}</h3>
        {data.byChannel.length === 0 ? <p className="text-sm text-gray-400">—</p> : data.byChannel.map((c) => (
          <div key={c.channel} className="mb-1.5 flex items-center gap-3 text-sm">
            <span className="w-28 text-gray-700">{t(`reports.cons.channel.${c.channel}`, { defaultValue: c.channel })}</span>
            <div className="h-2.5 flex-1 rounded bg-gray-100"><div className="h-2.5 rounded bg-blue-500" style={{ width: `${(c.contacts / maxChannel) * 100}%` }} /></div>
            <span className="w-12 text-right tabular-nums text-gray-600">{c.contacts}</span>
          </div>
        ))}
      </Card>

      <Card padding={false} className="overflow-x-auto">
        <div className="flex items-center justify-between px-4 pt-3">
          <h3 className="text-sm font-semibold text-gray-900">{t('reports.cons.series')}</h3>
          <select className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm" value={bucket} onChange={(e) => setBucket(e.target.value as ConsolidatedBucket)}>
            {(['day', 'week', 'month'] as const).map((b) => <option key={b} value={b}>{t(`reports.cons.bucket.${b}`)}</option>)}
          </select>
        </div>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-gray-500">
            <tr>{['period', 'callsIn', 'callsAnswered', 'callsMissed', 'callsOut', 'conversations', 'conversationsResolved', 'ticketsCreated', 'ticketsResolved'].map((c) => (
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
                <td className="px-4 py-2">{r.callsOut}</td>
                <td className="px-4 py-2">{r.conversations}</td>
                <td className="px-4 py-2">{r.conversationsResolved}</td>
                <td className="px-4 py-2">{r.ticketsCreated}</td>
                <td className="px-4 py-2">{r.ticketsResolved}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
