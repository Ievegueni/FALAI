import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Smile, Frown } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { csatApi, type CsatConfig, type CsatNegative, type CsatReport, type CsatSummary } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Input';
import { SERIES } from '@/components/reports/charts';
import { formatPhone } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Card, StatCard } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { PageSpinner } from '@/components/ui/Spinner';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { isOpsManager } from '@/lib/roles';

const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

/** Definições do inquérito (gestor/admin): canais, pergunta e agradecimento. */
function CsatSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const { data } = useQuery({ queryKey: ['csat', 'settings'], queryFn: csatApi.settings });
  const [form, setForm] = useState<CsatConfig | null>(null);
  useEffect(() => { if (data) setForm(data); }, [data]);
  const save = useMutation({
    mutationFn: () => csatApi.save(form!),
    onSuccess: (d) => { success(t('common.saved')); qc.setQueryData(['csat', 'settings'], d); },
    onError: (e: Error) => error(e.message),
  });
  if (!form) return null;
  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-900">{t('reports.csat.settings')}</h2>
      <div className="flex flex-wrap gap-4 text-sm text-gray-800">
        {(['voice', 'text', 'sms'] as const).map((k) => (
          <label key={k} className="flex items-center gap-2">
            <input type="checkbox" checked={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} />
            {t(`reports.csat.channel.${k.toUpperCase()}`)}
          </label>
        ))}
      </div>
      <p className="text-xs text-gray-500">{t('reports.csat.channelsHint')}</p>
      <Input label={t('reports.csat.question')} value={form.question} maxLength={300} onChange={(e) => setForm({ ...form, question: e.target.value })} />
      <Input label={t('reports.csat.thanks')} value={form.thanks} maxLength={200} onChange={(e) => setForm({ ...form, thanks: e.target.value })} />
      <div className="flex justify-end">
        <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
      </div>
    </Card>
  );
}

function SummaryTable({ title, rows, label }: { title: string; rows: (CsatSummary & { key: string | null; name?: string | null })[]; label: (r: { key: string | null; name?: string | null }) => string }) {
  const { t } = useTranslation();
  if (!rows.length) return null;
  return (
    <Card padding={false} className="overflow-x-auto">
      <h3 className="px-4 pt-3 text-sm font-semibold text-gray-900">{title}</h3>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-gray-500">
          <tr>{['name', 'responses', 'avg', 'satisfied'].map((k) => <th key={k} className="px-4 py-2 font-medium">{t(`reports.csat.col.${k}`)}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {rows.map((r) => (
            <tr key={r.key ?? '—'}>
              <td className="px-4 py-2 text-gray-900">{label(r)}</td>
              <td className="px-4 py-2">{r.responses}</td>
              <td className="px-4 py-2 font-semibold">{r.avg ?? '—'}</td>
              <td className="px-4 py-2">{pct(r.satisfiedPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

const AXIS = { fontSize: 11, fill: '#6b6b66' };

/** Média e % de satisfeitos por dia. */
function CsatTrend({ days }: { days: CsatReport['byDay'] }) {
  const { t } = useTranslation();
  if (days.length < 2) return null;
  const data = days.map((d) => ({ d: `${d.key.slice(8, 10)}/${d.key.slice(5, 7)}`, avg: d.avg, n: d.responses, sat: d.satisfiedPct }));
  return (
    <Card>
      <h2 className="text-sm font-semibold text-gray-900">{t('reports.csat.trend')}</h2>
      <p className="mb-3 text-xs text-gray-400">{t('reports.csat.trendHint')}</p>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid stroke="#eeeeea" vertical={false} />
            <XAxis dataKey="d" tick={AXIS} tickLine={false} axisLine={false} />
            <YAxis domain={[1, 5]} ticks={[1, 2, 3, 4, 5]} tick={AXIS} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: '#e5e5e0', padding: '4px 8px' }}
              formatter={(v, _n, item) => {
                const p = item.payload as { n: number; sat: number | null };
                return [`${v} · ${pct(p.sat)} ${t('reports.csat.satisfiedShort')} · ${p.n} ${t('reports.csat.responses').toLowerCase()}`, t('reports.csat.avg')];
              }}
            />
            <Line type="monotone" dataKey="avg" stroke={SERIES[0]} strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

/** Notas 1 e 2: o comentário do cliente e o tratamento pela supervisão. */
function Negatives({ rows, canReview }: { rows: CsatNegative[]; canReview: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [editing, setEditing] = useState<CsatNegative | null>(null);
  const [note, setNote] = useState('');
  const review = useMutation({
    mutationFn: (v: { id: string; reviewed: boolean; note?: string | null }) => csatApi.review(v.id, { reviewed: v.reviewed, note: v.note ?? null }),
    onSuccess: () => { success(t('common.saved')); setEditing(null); void qc.invalidateQueries({ queryKey: ['reports', 'csat'] }); },
    onError: (e: Error) => error(e.message),
  });
  const list = show === 'open' ? rows.filter((r) => !r.reviewedAt) : rows;
  const open = rows.filter((r) => !r.reviewedAt).length;
  return (
    <Card padding={false} className="overflow-x-auto">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900"><Frown className="h-4 w-4 text-red-500" /> {t('reports.csat.negatives', { count: open })}</h3>
          <p className="text-xs text-gray-400">{t('reports.csat.negativesHint')}</p>
        </div>
        <select className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm" value={show} onChange={(e) => setShow(e.target.value as 'open' | 'all')}>
          <option value="open">{t('reports.csat.showOpen')}</option>
          <option value="all">{t('reports.csat.showAll')}</option>
        </select>
      </div>
      {list.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-gray-400">{t('reports.csat.noNegatives')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-gray-500">
            <tr>{['when', 'score', 'channel', 'agent', 'customer', 'comment', 'status'].map((k) => <th key={k} className="px-4 py-2 font-medium">{t(`reports.csat.neg.${k}`)}</th>)}<th /></tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {list.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="whitespace-nowrap px-4 py-2 text-gray-600">{new Date(r.at).toLocaleString()}</td>
                <td className="px-4 py-2"><Badge className="bg-red-100 text-red-700">{r.score}</Badge></td>
                <td className="px-4 py-2 text-gray-600">{t(`reports.csat.channel.${r.channel}`)}</td>
                <td className="px-4 py-2 text-gray-700">{r.agent ?? '—'}{r.group && <span className="block text-xs text-gray-400">{r.group}</span>}</td>
                <td className="px-4 py-2">
                  {r.contact ? <Link to={`/contacts/${r.contact.id}`} className="text-blue-600 hover:underline">{r.contact.name || formatPhone(r.contact.phone ?? '')}</Link> : '—'}
                  <span className="mt-0.5 flex gap-2 text-xs">
                    {r.callId && <Link to={`/calls/${r.callId}`} className="text-blue-600 hover:underline">{t('reports.csat.neg.call')}</Link>}
                    {r.conversationId && <Link to={`/inbox?c=${r.conversationId}`} className="text-blue-600 hover:underline">{t('reports.csat.neg.conversation')}</Link>}
                    {r.ticketId && <Link to={`/tickets/${r.ticketId}`} className="text-blue-600 hover:underline">{t('reports.csat.neg.ticket')}</Link>}
                  </span>
                </td>
                <td className="max-w-xs px-4 py-2 text-gray-700">{r.comment ?? <span className="text-gray-400">{t('reports.csat.neg.noComment')}</span>}</td>
                <td className="px-4 py-2 text-xs">
                  {r.reviewedAt ? (
                    <span className="text-emerald-700">{t('reports.csat.neg.reviewedBy', { name: r.reviewedBy ?? '—' })}{r.reviewNote && <span className="block text-gray-500">{r.reviewNote}</span>}</span>
                  ) : <span className="text-amber-700">{t('reports.csat.neg.open')}</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  {canReview && (r.reviewedAt ? (
                    <Button size="sm" variant="ghost" onClick={() => review.mutate({ id: r.id, reviewed: false })}>{t('reports.csat.neg.reopen')}</Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => { setEditing(r); setNote(''); }}>{t('reports.csat.neg.review')}</Button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={t('reports.csat.neg.reviewTitle')}
        footer={<Button loading={review.isPending} onClick={() => editing && review.mutate({ id: editing.id, reviewed: true, note: note.trim() || null })}>{t('reports.csat.neg.review')}</Button>}
      >
        <Textarea label={t('reports.csat.neg.reviewNote')} value={note} maxLength={2000} rows={4} onChange={(e) => setNote(e.target.value)} />
      </Modal>
    </Card>
  );
}

/** Satisfação (CSAT) no período — com o âmbito do papel (a API filtra). */
export function CsatTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['reports', 'csat', from, to], queryFn: () => csatApi.report({ from, to }) });
  return (
    <div className="space-y-4">
      {isOpsManager(user?.role) && <CsatSettings />}
      {isLoading || !data ? <PageSpinner /> : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label={t('reports.csat.avg')} value={data.overall.avg ?? '—'} sub={t('reports.csat.scale')} icon={<Smile className="h-5 w-5" />} />
            <StatCard label={t('reports.csat.satisfied')} value={pct(data.overall.satisfiedPct)} sub={t('reports.csat.satisfiedHint')} icon={<Smile className="h-5 w-5" />} />
            <StatCard label={t('reports.csat.responses')} value={data.overall.responses} sub={t('reports.csat.responseRate', { asked: data.asked })} icon={<Smile className="h-5 w-5" />} />
            <Card>
              <p className="mb-2 text-xs text-gray-500">{t('reports.csat.distribution')}</p>
              {(['5', '4', '3', '2', '1'] as const).map((k) => {
                const n = data.overall.distribution[k];
                const w = data.overall.responses ? (n / data.overall.responses) * 100 : 0;
                return (
                  <div key={k} className="flex items-center gap-2 text-xs">
                    <span className="w-3 text-gray-600">{k}</span>
                    <div className="h-2 flex-1 rounded bg-gray-100"><div className="h-2 rounded bg-blue-500" style={{ width: `${w}%` }} /></div>
                    <span className="w-6 text-right text-gray-500">{n}</span>
                  </div>
                );
              })}
            </Card>
          </div>
          <CsatTrend days={data.byDay} />
          <Negatives rows={data.negatives} canReview={isOpsManager(user?.role) || user?.role === 'SUPERVISOR'} />
          <SummaryTable title={t('reports.csat.byChannel')} rows={data.byChannel} label={(r) => t(`reports.csat.channel.${r.key}`)} />
          <SummaryTable title={t('reports.csat.byAgent')} rows={data.byAgent} label={(r) => r.name ?? t('reports.csat.noAgent')} />
          <SummaryTable title={t('reports.csat.byGroup')} rows={data.byGroup} label={(r) => r.name ?? t('reports.csat.noGroup')} />
        </>
      )}
    </div>
  );
}
