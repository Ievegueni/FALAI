import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Copy, PlugZap, RefreshCw } from 'lucide-react';
import { helpdeskApi, type TicketOnCall } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import { formatDate } from '@/lib/utils';

/**
 * Ligação ao Freshdesk do cliente (fase 3). Os administradores configuram; o
 * gestor vê o estado. Os tickets passam a ser espelho do Freshdesk.
 */
export function HelpdeskPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['helpdesk'], queryFn: helpdeskApi.get });
  const [f, setF] = useState({ domain: '', apiKey: '', enabled: false, ticketOnCall: 'AGENT_CHOICE' as TicketOnCall, includeRecordingLink: false });
  useEffect(() => {
    if (data?.configured) setF({ domain: data.domain ?? '', apiKey: '', enabled: !!data.enabled, ticketOnCall: data.ticketOnCall ?? 'AGENT_CHOICE', includeRecordingLink: !!data.includeRecordingLink });
  }, [data]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['helpdesk'] });

  const save = useMutation({
    mutationFn: () => helpdeskApi.save({ domain: f.domain, ...(f.apiKey.trim() && { apiKey: f.apiKey.trim() }), enabled: f.enabled, ticketOnCall: f.ticketOnCall, includeRecordingLink: f.includeRecordingLink }),
    onSuccess: () => { success(t('common.saved')); setF((x) => ({ ...x, apiKey: '' })); refresh(); },
    onError: (e: Error) => error(e.message),
  });
  const test = useMutation({ mutationFn: helpdeskApi.test, onSuccess: (r) => success(t('helpdesk.testOk', { name: r.agent ?? '?' })), onError: (e: Error) => error(e.message) });
  const sync = useMutation({
    mutationFn: helpdeskApi.sync,
    onSuccess: (r) => { success(t('helpdesk.synced', { created: r.created, updated: r.updated })); refresh(); void qc.invalidateQueries({ queryKey: ['tickets'] }); },
    onError: (e: Error) => error(e.message),
  });

  if (isLoading || !data) return <><Header title={t('helpdesk.title')} /><PageSpinner /></>;
  const ro = !data.canEdit;

  return (
    <>
      <Header title={t('helpdesk.title')} actions={<Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => navigate('/tickets')}>{t('common.back')}</Button>} />
      <div className="max-w-2xl space-y-4 p-4 sm:p-6">
        <p className="text-sm text-gray-600">{t('helpdesk.intro')}</p>

        <Card className="space-y-4">
          <fieldset disabled={ro} className="space-y-4">
            <Input label={t('helpdesk.domain')} value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} placeholder="empresa.freshdesk.com" />
            <Input
              label={t('helpdesk.apiKey')}
              type="password"
              autoComplete="off"
              value={f.apiKey}
              onChange={(e) => setF({ ...f, apiKey: e.target.value })}
              placeholder={data.apiKeySet ? t('helpdesk.apiKeyKept') : ''}
              hint={t('helpdesk.apiKeyHint')}
            />
            <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
              {t('helpdesk.ticketOnCall')}
              <select className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700" value={f.ticketOnCall} onChange={(e) => setF({ ...f, ticketOnCall: e.target.value as TicketOnCall })}>
                {(['AGENT_CHOICE', 'ALWAYS', 'NEVER'] as const).map((o) => <option key={o} value={o}>{t(`helpdesk.onCall.${o}`)}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-800">
              <input type="checkbox" checked={f.includeRecordingLink} onChange={(e) => setF({ ...f, includeRecordingLink: e.target.checked })} />
              {t('helpdesk.recordingLink')}
            </label>
            <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
              <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
              {t('helpdesk.enabled')}
            </label>
          </fieldset>
          {!ro && (
            <div className="flex flex-wrap justify-end gap-2">
              {data.configured && <Button variant="outline" size="sm" icon={<PlugZap className="h-4 w-4" />} loading={test.isPending} onClick={() => test.mutate()}>{t('helpdesk.test')}</Button>}
              {data.enabled && <Button variant="outline" size="sm" icon={<RefreshCw className="h-4 w-4" />} loading={sync.isPending} onClick={() => sync.mutate()}>{t('helpdesk.syncNow')}</Button>}
              <Button size="sm" loading={save.isPending} disabled={!f.domain.trim() || (!data.configured && !f.apiKey.trim())} onClick={() => save.mutate()}>{t('common.save')}</Button>
            </div>
          )}
        </Card>

        {data.configured && (
          <Card className="space-y-1 text-sm">
            <p className="text-gray-700">{t('helpdesk.lastSync')}: <span className="font-medium">{data.lastSyncAt ? formatDate(data.lastSyncAt) : '—'}</span></p>
            {data.lastError && <p className="text-red-600">{t('helpdesk.lastError')}: {data.lastError} {data.lastErrorAt && `(${formatDate(data.lastErrorAt)})`}</p>}
          </Card>
        )}

        {data.webhookUrl && (
          <Card className="space-y-3 text-sm">
            <h2 className="font-semibold text-gray-900">{t('helpdesk.webhookTitle')}</h2>
            <ol className="list-decimal space-y-1 pl-5 text-gray-700">
              {(t('helpdesk.webhookSteps', { returnObjects: true }) as string[]).map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            {[{ label: 'URL', value: data.webhookUrl }, { label: t('helpdesk.webhookBody'), value: data.webhookBody ?? '' }].map((x) => (
              <div key={x.label}>
                <p className="mb-1 text-xs text-gray-500">{x.label}</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs">{x.value}</code>
                  <Button size="sm" variant="outline" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => void navigator.clipboard.writeText(x.value)} />
                </div>
              </div>
            ))}
          </Card>
        )}
      </div>
    </>
  );
}
