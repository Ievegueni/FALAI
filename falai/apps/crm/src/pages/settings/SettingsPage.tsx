import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Save, RotateCcw } from 'lucide-react';
import { settingsApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';

export function SettingsPage() {
  const { t } = useTranslation();
  const { refreshMe } = useAuth();
  const qc = useQueryClient();
  const { success, error } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.get,
  });

  const [form, setForm] = useState({
    name: '',
    webhookUrl: '',
    fiscalName: '',
    fiscalNif: '',
    fiscalAddress: '',
    lowBalanceAlertCents: '',
    lowBalanceAlertEmail: '',
    lowBalanceAlertPhone: '',
  });

  useEffect(() => {
    if (!data) return;
    setForm({
      name: data.name,
      webhookUrl: data.webhookUrl ?? '',
      fiscalName: data.fiscalName ?? '',
      fiscalNif: data.fiscalNif ?? '',
      fiscalAddress: data.fiscalAddress ?? '',
      lowBalanceAlertCents: data.lowBalanceAlertCents ? String(data.lowBalanceAlertCents / 100) : '',
      lowBalanceAlertEmail: data.lowBalanceAlertEmail ?? '',
      lowBalanceAlertPhone: data.lowBalanceAlertPhone ?? '',
    });
  }, [data]);

  function set(k: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  const save = useMutation({
    mutationFn: () =>
      settingsApi.update({
        name: form.name,
        webhookUrl: form.webhookUrl || null,
        fiscalName: form.fiscalName || null,
        fiscalNif: form.fiscalNif || null,
        fiscalAddress: form.fiscalAddress || null,
        lowBalanceAlertCents: form.lowBalanceAlertCents
          ? Math.round(parseFloat(form.lowBalanceAlertCents) * 100)
          : null,
        lowBalanceAlertEmail: form.lowBalanceAlertEmail || null,
        lowBalanceAlertPhone: form.lowBalanceAlertPhone || null,
      }),
    onSuccess: () => {
      success(t('settings.saved'));
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void refreshMe();
    },
    onError: (e: Error) => error(e.message),
  });

  const rotateSecret = useMutation({
    mutationFn: settingsApi.rotateSecret,
    onSuccess: () => success(t('settings.secretRotated')),
    onError: (e: Error) => error(e.message),
  });

  if (isLoading) return <><Header title={t('settings.title')} /><PageSpinner /></>;

  return (
    <>
      <Header title={t('settings.title')} />

      <div className="p-6 max-w-2xl space-y-6">
        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('settings.companyInfo')}</h2>
          <div className="flex flex-col gap-4">
            <Input
              label={t('settings.companyName')}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              required
            />
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('settings.fiscalData')}</h2>
          <div className="flex flex-col gap-4">
            <Input
              label={t('settings.fiscalName')}
              value={form.fiscalName}
              onChange={(e) => set('fiscalName', e.target.value)}
              placeholder={t('settings.fiscalNamePlaceholder')}
            />
            <Input
              label={t('settings.nif')}
              value={form.fiscalNif}
              onChange={(e) => set('fiscalNif', e.target.value)}
              placeholder="5000000000"
            />
            <Textarea
              label={t('settings.fiscalAddress')}
              value={form.fiscalAddress}
              onChange={(e) => set('fiscalAddress', e.target.value)}
              placeholder={t('settings.fiscalAddressPlaceholder')}
              rows={2}
            />
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('settings.integrations')}</h2>
          <div className="flex flex-col gap-4">
            <Input
              label={t('settings.webhookUrl')}
              type="url"
              value={form.webhookUrl}
              onChange={(e) => set('webhookUrl', e.target.value)}
              placeholder={t('settings.webhookUrlPlaceholder')}
              hint={t('settings.webhookHint')}
            />
            {data?.webhookUrl && (
              <div>
                <p className="text-sm font-medium text-gray-700 mb-1">{t('settings.hmacSecret')}</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-500 font-mono">
                    {'•'.repeat(40)}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<RotateCcw className="h-3.5 w-3.5" />}
                    loading={rotateSecret.isPending}
                    onClick={() => {
                      if (confirm(t('settings.regenerateConfirm'))) {
                        rotateSecret.mutate();
                      }
                    }}
                  >
                    {t('settings.regenerate')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('settings.lowBalanceAlerts')}</h2>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label={t('settings.thresholdLabel')}
              value={form.lowBalanceAlertCents}
              onChange={(e) => set('lowBalanceAlertCents', e.target.value)}
              placeholder={t('settings.thresholdPlaceholder')}
              hint={t('settings.thresholdHint')}
            />
            <Input
              label={t('settings.alertEmail')}
              type="email"
              value={form.lowBalanceAlertEmail}
              onChange={(e) => set('lowBalanceAlertEmail', e.target.value)}
              placeholder={t('settings.alertEmailPlaceholder')}
            />
            <Input
              label={t('settings.alertPhone')}
              value={form.lowBalanceAlertPhone}
              onChange={(e) => set('lowBalanceAlertPhone', e.target.value)}
              placeholder="+244 9XX XXX XXX"
            />
          </div>
        </Card>

        <Button
          icon={<Save className="h-4 w-4" />}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {t('settings.save')}
        </Button>
      </div>
    </>
  );
}
