import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Save } from 'lucide-react';
import { alertsApi, type AlertType, type ServiceTargets } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Pagination } from '@/components/ui/Pagination';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import { alertText, alertValue } from '@/components/alerts/alertText';

const TYPES: AlertType[] = ['LONG_WAIT', 'LONG_HANDLE', 'NO_AGENTS', 'SLA_BELOW', 'ABANDON_ABOVE', 'TMA_ABOVE'];

/** Alertas abertos agora (topo do painel ao vivo). Some quando não há nenhum. */
export function OpenAlerts() {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: ['alerts', 'open'], queryFn: () => alertsApi.list({ open: true }), refetchInterval: 10_000, retry: false });
  if (!data?.data.length) return null;
  return (
    <Card className="border-amber-200 bg-amber-50">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-amber-800">
        <AlertTriangle className="h-4 w-4" /> {t('alerts.openTitle', { count: data.total })}
      </h2>
      <ul className="space-y-1 text-sm text-amber-900">
        {data.data.map((a) => (
          <li key={a.id} className="flex justify-between gap-3">
            <span>{alertText(t, a)}</span>
            <span className="shrink-0 text-xs text-amber-700">{new Date(a.startedAt).toLocaleTimeString()}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Histórico: o relatório de desvios (quantos, de que tipo, quanto duraram). */
export function AlertsHistory() {
  const { t } = useTranslation();
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ from: today, to: today, type: '' as AlertType | '', page: 1 });
  const { data, isLoading } = useQuery({
    queryKey: ['alerts', 'history', f],
    queryFn: () => alertsApi.list({ from: f.from, to: f.to, page: f.page, ...(f.type && { type: f.type }) }),
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p, page: p.page ?? 1 }));
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">{t('reports.from')}</label>
          <input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">{t('reports.to')}</label>
          <input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <select value={f.type} onChange={(e) => set({ type: e.target.value as AlertType | '' })} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" aria-label={t('alerts.typeLabel')}>
          <option value="">{t('alerts.allTypes')}</option>
          {TYPES.map((ty) => <option key={ty} value={ty}>{t(`alerts.name.${ty}`)}</option>)}
        </select>
      </Card>
      {data && Object.keys(data.byType).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {TYPES.filter((ty) => data.byType[ty]).map((ty) => (
            <Badge key={ty} className="bg-amber-100 text-amber-800">{t(`alerts.name.${ty}`)}: {data.byType[ty]}</Badge>
          ))}
        </div>
      )}
      {isLoading || !data ? (
        <PageSpinner />
      ) : data.total === 0 ? (
        <Card><p className="py-6 text-center text-sm text-gray-400">{t('alerts.empty')}</p></Card>
      ) : (
        <Card padding={false} className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">{t('alerts.started')}</th>
                <th className="px-4 py-2.5 font-medium">{t('alerts.typeLabel')}</th>
                <th className="px-4 py-2.5 font-medium">{t('alerts.group')}</th>
                <th className="px-4 py-2.5 font-medium">{t('alerts.threshold')}</th>
                <th className="px-4 py-2.5 font-medium">{t('alerts.value')}</th>
                <th className="px-4 py-2.5 font-medium">{t('alerts.ended')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.data.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-2.5 text-gray-700">{new Date(a.startedAt).toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-gray-900">{t(`alerts.name.${a.type}`)}</td>
                  <td className="px-4 py-2.5 text-gray-700">{a.group ?? '—'}</td>
                  <td className="px-4 py-2.5 text-gray-700">{alertValue(a.type, a.threshold)}</td>
                  <td className="px-4 py-2.5 text-gray-700">
                    {alertValue(a.type, a.value)}
                    {a.endValue !== null && <span className="text-gray-400"> → {alertValue(a.type, a.endValue)}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-600">{a.endedAt ? new Date(a.endedAt).toLocaleTimeString() : t('alerts.ongoing')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-4 py-3">
            <Pagination page={data.page} total={data.total} perPage={data.perPage} onPage={(page) => set({ page })} />
          </div>
        </Card>
      )}
    </div>
  );
}

type Field = keyof ServiceTargets;
const FIELDS: { key: Field; unit: 's' | '%' | 'n' }[] = [
  { key: 'slaThresholdSecs', unit: 's' },
  { key: 'slaTargetPct', unit: '%' },
  { key: 'maxWaitSecs', unit: 's' },
  { key: 'maxHandleSecs', unit: 's' },
  { key: 'minAvailableAgents', unit: 'n' },
  { key: 'maxAbandonPct', unit: '%' },
  { key: 'maxTmaSecs', unit: 's' },
];

/** Metas e limites dos alertas (gestor/admin). Campo vazio = alerta desligado. */
export function TargetsCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const { data } = useQuery({ queryKey: ['alerts', 'settings'], queryFn: alertsApi.settings });
  const [form, setForm] = useState<Record<Field, string>>({} as Record<Field, string>);
  useEffect(() => {
    if (data) setForm(Object.fromEntries(FIELDS.map(({ key }) => [key, data[key] === null ? '' : String(data[key])])) as Record<Field, string>);
  }, [data]);
  const save = useMutation({
    mutationFn: () =>
      alertsApi.saveSettings(
        Object.fromEntries(FIELDS.map(({ key }) => [key, form[key]?.trim() ? Number(form[key]) : key === 'slaThresholdSecs' ? 21 : null])) as unknown as ServiceTargets,
      ),
    onSuccess: (d) => { success(t('common.saved')); qc.setQueryData(['alerts', 'settings'], d); },
    onError: (e: Error) => error(e.message),
  });
  if (!data) return <PageSpinner />;
  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-900">{t('alerts.targetsTitle')}</h2>
        <p className="text-xs text-gray-500">{t('alerts.targetsHint')}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map(({ key, unit }) => (
          <Input
            key={key}
            type="number"
            min={0}
            label={`${t(`alerts.field.${key}`)} (${t(`alerts.unit.${unit}`)})`}
            value={form[key] ?? ''}
            onChange={(e) => setForm((x) => ({ ...x, [key]: e.target.value }))}
            placeholder={key === 'slaThresholdSecs' ? '21' : t('alerts.off')}
          />
        ))}
      </div>
      <div className="flex justify-end">
        <Button size="sm" icon={<Save className="h-4 w-4" />} loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
      </div>
    </Card>
  );
}
