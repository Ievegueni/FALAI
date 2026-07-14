import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
      success('Definições guardadas');
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void refreshMe();
    },
    onError: (e: Error) => error(e.message),
  });

  const rotateSecret = useMutation({
    mutationFn: settingsApi.rotateSecret,
    onSuccess: () => success('Secret do webhook regenerado'),
    onError: (e: Error) => error(e.message),
  });

  if (isLoading) return <><Header title="Definições" /><PageSpinner /></>;

  return (
    <>
      <Header title="Definições" />

      <div className="p-6 max-w-2xl space-y-6">
        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Informações da empresa</h2>
          <div className="flex flex-col gap-4">
            <Input
              label="Nome da empresa"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              required
            />
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Dados fiscais</h2>
          <div className="flex flex-col gap-4">
            <Input
              label="Nome fiscal"
              value={form.fiscalName}
              onChange={(e) => set('fiscalName', e.target.value)}
              placeholder="Empresa, Lda"
            />
            <Input
              label="NIF"
              value={form.fiscalNif}
              onChange={(e) => set('fiscalNif', e.target.value)}
              placeholder="5000000000"
            />
            <Textarea
              label="Endereço fiscal"
              value={form.fiscalAddress}
              onChange={(e) => set('fiscalAddress', e.target.value)}
              placeholder="Rua…, Luanda, Angola"
              rows={2}
            />
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Integrações</h2>
          <div className="flex flex-col gap-4">
            <Input
              label="Webhook URL"
              type="url"
              value={form.webhookUrl}
              onChange={(e) => set('webhookUrl', e.target.value)}
              placeholder="https://empresa.ao/webhook/falai"
              hint="Receberá eventos de chamadas e campanhas assinados com HMAC."
            />
            {data?.webhookUrl && (
              <div>
                <p className="text-sm font-medium text-gray-700 mb-1">Secret HMAC</p>
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
                      if (confirm('Regenerar o secret invalida a assinatura de eventos futuros. Continuar?')) {
                        rotateSecret.mutate();
                      }
                    }}
                  >
                    Regenerar
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Alertas de saldo baixo</h2>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Limiar de alerta (Kz)"
              value={form.lowBalanceAlertCents}
              onChange={(e) => set('lowBalanceAlertCents', e.target.value)}
              placeholder="ex: 5000"
              hint="Recebe alerta quando o saldo baixar deste valor"
            />
            <Input
              label="Email de alerta"
              type="email"
              value={form.lowBalanceAlertEmail}
              onChange={(e) => set('lowBalanceAlertEmail', e.target.value)}
              placeholder="gestor@empresa.ao"
            />
            <Input
              label="Telemóvel de alerta"
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
          Guardar definições
        </Button>
      </div>
    </>
  );
}
