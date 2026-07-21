import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Send, Megaphone, AlertCircle } from 'lucide-react';
import { smsApi, contactsApi, ApiError } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import { PageSpinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { formatAOA, formatDate, formatPhone } from '@/lib/utils';
import type { SmsStatus } from '@/types';

const statusColor: Record<SmsStatus, string> = {
  QUEUED: 'bg-amber-100 text-amber-700',
  SENT: 'bg-blue-100 text-blue-700',
  DELIVERED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-700',
};

export function SmsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState('send');

  const { data: config, isLoading } = useQuery({ queryKey: ['sms-config'], queryFn: smsApi.config });

  if (isLoading) return <PageSpinner />;

  return (
    <div>
      <Header title={t('nav.sms')} />
      <div className="p-6 space-y-6">
        {config && !config.enabled && (
          <Card className="flex items-center gap-3 border-amber-200 bg-amber-50">
            <AlertCircle className="h-5 w-5 text-amber-500" />
            <p className="text-sm text-amber-800">{t('sms.notEnabled')}</p>
          </Card>
        )}
        {config && config.enabled && !config.configured && (
          <Card className="flex items-center gap-3 border-amber-200 bg-amber-50">
            <AlertCircle className="h-5 w-5 text-amber-500" />
            <p className="text-sm text-amber-800">{t('sms.notConfigured')}</p>
          </Card>
        )}

        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'send', label: t('sms.tabSend') },
            { key: 'history', label: t('sms.tabHistory') },
            { key: 'campaigns', label: t('sms.tabCampaigns') },
          ]}
        />

        {tab === 'send' && <SendTab canSend={!!config?.enabled && !!config?.configured} priceCents={config?.pricePerSegmentCents ?? 0} />}
        {tab === 'history' && <HistoryTab />}
        {tab === 'campaigns' && <CampaignsTab canSend={!!config?.enabled && !!config?.configured} />}
      </div>
    </div>
  );
}

function SendTab({ canSend, priceCents }: { canSend: boolean; priceCents: number }) {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');

  const { data: preview } = useQuery({
    queryKey: ['sms-preview', body],
    queryFn: () => smsApi.preview(body),
    enabled: body.length > 0,
  });

  const send = useMutation({
    mutationFn: () => smsApi.send({ to, body }),
    onSuccess: () => {
      toast.success(t('sms.sent'));
      setTo('');
      setBody('');
      void qc.invalidateQueries({ queryKey: ['sms-history'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('sms.sendError')),
  });

  const segments = preview?.segments ?? (body ? 1 : 0);
  const cost = preview?.costCents ?? segments * priceCents;

  return (
    <Card className="max-w-xl space-y-4">
      <Input label={t('sms.to')} value={to} onChange={(e) => setTo(e.target.value)} placeholder="+2449XXXXXXXX" />
      <div>
        <label className="text-sm font-medium text-gray-700">{t('sms.message')}</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          maxLength={1000}
          className="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500"
          placeholder={t('sms.messagePlaceholder')}
        />
        <div className="mt-1 flex justify-between text-xs text-gray-400">
          <span>{t('sms.segments', { count: segments })} · {body.length} {t('sms.chars')}</span>
          <span className="font-medium text-gray-600">{t('sms.estCost')}: {formatAOA(cost)}</span>
        </div>
      </div>
      <Button
        icon={<Send className="h-4 w-4" />}
        disabled={!canSend || !to || !body || send.isPending}
        onClick={() => send.mutate()}
      >
        {t('sms.send')}
      </Button>
    </Card>
  );
}

function HistoryTab() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({ queryKey: ['sms-history'], queryFn: () => smsApi.list() });

  if (isLoading) return <PageSpinner />;
  if (!data || data.data.length === 0)
    return <EmptyState icon={<MessageSquare className="h-6 w-6" />} title={t('sms.emptyTitle')} description={t('sms.emptyDescription')} />;

  return (
    <Card padding={false}>
      <table className="w-full">
        <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
          <tr>
            <th className="px-4 py-3">{t('sms.to')}</th>
            <th className="px-4 py-3">{t('sms.message')}</th>
            <th className="px-4 py-3">{t('common.status')}</th>
            <th className="px-4 py-3">{t('sms.cost')}</th>
            <th className="px-4 py-3">{t('common.date')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {data.data.map((m) => (
            <tr key={m.id}>
              <td className="px-4 py-3 text-sm text-gray-900">{m.contact?.name ?? formatPhone(m.toNumber)}</td>
              <td className="max-w-xs truncate px-4 py-3 text-sm text-gray-500">{m.body}</td>
              <td className="px-4 py-3"><Badge className={statusColor[m.status]}>{t(`sms.status.${m.status}`)}</Badge></td>
              <td className="px-4 py-3 text-sm text-gray-500">{formatAOA(m.costCents)}</td>
              <td className="px-4 py-3 text-xs text-gray-400">{formatDate(m.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function CampaignsTab({ canSend }: { canSend: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');

  const { data: campaigns, isLoading } = useQuery({ queryKey: ['sms-campaigns'], queryFn: smsApi.campaigns });

  const create = useMutation({
    mutationFn: async () => {
      // Envia a todos os contactos (1ª versão); refinamentos de segmentação depois
      const contacts = await contactsApi.list({ page: 1 });
      const contactIds = contacts.data.map((c) => c.id);
      return smsApi.createCampaign({ name, body, contactIds });
    },
    onSuccess: () => {
      toast.success(t('sms.campaignCreated'));
      setCreating(false);
      setName('');
      setBody('');
      void qc.invalidateQueries({ queryKey: ['sms-campaigns'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveError')),
  });

  const start = useMutation({
    mutationFn: (id: string) => smsApi.startCampaign(id),
    onSuccess: () => {
      toast.success(t('sms.campaignStarted'));
      void qc.invalidateQueries({ queryKey: ['sms-campaigns'] });
    },
  });

  if (isLoading) return <PageSpinner />;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button icon={<Megaphone className="h-4 w-4" />} disabled={!canSend} onClick={() => setCreating(true)}>
          {t('sms.newCampaign')}
        </Button>
      </div>

      {creating && (
        <Card className="max-w-xl space-y-4">
          <Input label={t('sms.campaignName')} value={name} onChange={(e) => setName(e.target.value)} />
          <div>
            <label className="text-sm font-medium text-gray-700">{t('sms.message')}</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              className="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              placeholder={t('sms.templatePlaceholder')}
            />
            <p className="mt-1 text-xs text-gray-400">{t('sms.templateHint')}</p>
          </div>
          <div className="flex gap-2">
            <Button disabled={!name || !body || create.isPending} onClick={() => create.mutate()}>
              {t('common.create')}
            </Button>
            <Button variant="outline" onClick={() => setCreating(false)}>{t('common.cancel')}</Button>
          </div>
        </Card>
      )}

      {(!campaigns || campaigns.length === 0) && !creating ? (
        <EmptyState icon={<Megaphone className="h-6 w-6" />} title={t('sms.noCampaigns')} description={t('sms.noCampaignsDesc')} />
      ) : (
        <div className="grid gap-3">
          {campaigns?.map((c) => (
            <Card key={c.id} className="flex items-center justify-between">
              <div>
                <p className="font-medium text-gray-900">{c.name}</p>
                <p className="text-xs text-gray-400">
                  {t('sms.recipients', { count: c.totalRecipients })} · {t('sms.sentCount', { count: c.sentCount })}
                  {c.failedCount > 0 && ` · ${t('sms.failedCount', { count: c.failedCount })}`} · {formatAOA(c.costCents)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge className="bg-gray-100 text-gray-600">{c.status}</Badge>
                {(c.status === 'DRAFT') && (
                  <Button size="sm" onClick={() => start.mutate(c.id)} disabled={start.isPending || c.totalRecipients === 0}>
                    {t('sms.startCampaign')}
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
