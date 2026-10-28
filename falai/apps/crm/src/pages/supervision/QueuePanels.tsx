import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { queueApi, type QueueCallbackStatus, type QueueConfig } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import { formatPhone } from '@/lib/utils';

/** Fila de espera e oferta de callback (gestor/admin) — ver services/callQueue.service.ts. */
export function QueueSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const { data } = useQuery({ queryKey: ['queue', 'settings'], queryFn: queueApi.settings });
  const [form, setForm] = useState<QueueConfig | null>(null);
  useEffect(() => { if (data) setForm(data); }, [data]);
  const save = useMutation({
    mutationFn: () => queueApi.save(form!),
    onSuccess: (d) => { success(t('common.saved')); qc.setQueryData(['queue', 'settings'], d); },
    onError: (e: Error) => error(e.message),
  });
  if (!form) return null;
  const num = (v: string) => Math.max(0, Math.round(Number(v) || 0));
  return (
    <Card className="max-w-2xl space-y-3">
      <h2 className="text-sm font-semibold text-gray-900">{t('queue.settings.title')}</h2>
      <Input
        type="number"
        min={0}
        max={60}
        label={t('queue.settings.maxWait')}
        hint={t('queue.settings.maxWaitHint')}
        value={Math.round(form.maxWaitSecs / 60)}
        onChange={(e) => setForm({ ...form, maxWaitSecs: Math.min(60, num(e.target.value)) * 60 })}
      />
      <label className="flex items-center gap-2 text-sm text-gray-800">
        <input type="checkbox" checked={form.callback} onChange={(e) => setForm({ ...form, callback: e.target.checked })} />
        {t('queue.settings.callback')}
      </label>
      <p className="text-xs text-gray-500">{t('queue.settings.callbackHint')}</p>
      {form.callback && (
        <>
          <Input
            type="number"
            min={10}
            label={t('queue.settings.callbackAfter')}
            value={form.callbackAfterSecs}
            onChange={(e) => setForm({ ...form, callbackAfterSecs: Math.max(10, num(e.target.value)) })}
          />
          <Input label={t('queue.settings.offer')} value={form.offer} maxLength={300} onChange={(e) => setForm({ ...form, offer: e.target.value })} />
          <Input label={t('queue.settings.thanks')} value={form.thanks} maxLength={200} onChange={(e) => setForm({ ...form, thanks: e.target.value })} />
        </>
      )}
      <div className="flex justify-end">
        <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
      </div>
    </Card>
  );
}

const STATUS_CLASS: Record<QueueCallbackStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  ASSIGNED: 'bg-blue-100 text-blue-800',
  DONE: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
  CANCELLED: 'bg-gray-100 text-gray-600',
};

/** Pedidos de callback (o agente vê os seus; o âmbito vem da API). */
export function CallbacksList() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<QueueCallbackStatus | ''>('');
  const { data, isLoading } = useQuery({
    queryKey: ['queue', 'callbacks', status],
    queryFn: () => queueApi.callbacks(status ? { status } : {}),
    refetchInterval: 10_000,
  });
  return (
    <div className="space-y-3">
      <select className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm" value={status} onChange={(e) => setStatus(e.target.value as QueueCallbackStatus | '')}>
        <option value="">{t('queue.list.all')}</option>
        {(Object.keys(STATUS_CLASS) as QueueCallbackStatus[]).map((s) => <option key={s} value={s}>{t(`queue.status.${s}`)}</option>)}
      </select>
      {isLoading || !data ? <PageSpinner /> : (
        <Card padding={false} className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>{['requested', 'number', 'status', 'attempts', 'agent'].map((k) => <th key={k} className="px-4 py-2.5 font-medium">{t(`queue.list.${k}`)}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.data.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2.5 text-gray-700">{new Date(c.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-2.5 font-medium text-gray-900">{formatPhone(c.number)}</td>
                  <td className="px-4 py-2.5"><Badge className={STATUS_CLASS[c.status]}>{t(`queue.status.${c.status}`)}</Badge></td>
                  <td className="px-4 py-2.5 text-gray-700">{c.attempts}</td>
                  <td className="px-4 py-2.5 text-gray-700">{c.assignedTo?.name ?? '—'}</td>
                </tr>
              ))}
              {data.data.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">{t('queue.list.empty')}</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
