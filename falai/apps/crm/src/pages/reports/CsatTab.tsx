import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Smile } from 'lucide-react';
import { csatApi, type CsatConfig, type CsatSummary } from '@/lib/api';
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
          <SummaryTable title={t('reports.csat.byChannel')} rows={data.byChannel} label={(r) => t(`reports.csat.channel.${r.key}`)} />
          <SummaryTable title={t('reports.csat.byAgent')} rows={data.byAgent} label={(r) => r.name ?? t('reports.csat.noAgent')} />
          <SummaryTable title={t('reports.csat.byGroup')} rows={data.byGroup} label={(r) => r.name ?? t('reports.csat.noGroup')} />
        </>
      )}
    </div>
  );
}
