import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Server, PlugZap, CheckCircle2, XCircle, Info, Webhook, Copy, Check } from 'lucide-react';
import { pbxApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';

export function PbxIntegrationPage() {
  const qc = useQueryClient();
  const { success, error } = useToast();

  const { data, isLoading } = useQuery({ queryKey: ['pbx'], queryFn: pbxApi.get });

  const [form, setForm] = useState({ baseUrl: '', clientId: '', clientSecret: '', extension: '' });
  const [copied, setCopied] = useState(false);

  function copyWebhook() {
    if (!data?.config.webhookUrl) return;
    void navigator.clipboard.writeText(data.config.webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  useEffect(() => {
    if (!data) return;
    setForm({
      baseUrl: data.config.baseUrl ?? '',
      clientId: data.config.clientId ?? '',
      clientSecret: '',
      extension: data.config.extension ?? '',
    });
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      pbxApi.save({
        baseUrl: form.baseUrl,
        clientId: form.clientId,
        ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
        extension: form.extension || undefined,
      }),
    onSuccess: async () => {
      success('Credenciais guardadas');
      setForm((f) => ({ ...f, clientSecret: '' }));
      await qc.invalidateQueries({ queryKey: ['pbx'] });
    },
    onError: (e: Error) => error(e.message),
  });

  const test = useMutation({
    mutationFn: () => pbxApi.test(),
    onSuccess: async (res) => {
      success(`Ligação OK — ${res.extensionsCount} extensões encontradas`);
      await qc.invalidateQueries({ queryKey: ['pbx'] });
    },
    onError: (e: Error) => error(e.message),
  });

  if (isLoading) return <><Header title="Integração PBX" /><PageSpinner /></>;

  // Só planos CRM (bring-your-own-PBX) podem configurar um PBX próprio
  if (data && data.productType !== 'CRM_BYO_PBX') {
    return (
      <>
        <Header title="Integração PBX" />
        <div className="p-6 max-w-xl">
          <Card>
            <div className="flex items-start gap-3 text-sm text-gray-600">
              <Info className="h-5 w-5 text-gray-400 flex-shrink-0" />
              <p>
                O teu plano usa a telefonia gerida pela plataforma, por isso não é necessário configurar
                um PBX próprio. Esta secção só se aplica a planos <strong>CRM</strong> (com o teu próprio Yeastar).
              </p>
            </div>
          </Card>
        </div>
      </>
    );
  }

  const connected = data?.config.connected;

  return (
    <>
      <Header title="Integração PBX" />
      <div className="p-6 max-w-xl space-y-6">
        <div className="flex items-center justify-between rounded-lg border px-4 py-3"
          style={{ borderColor: connected ? '#bbf7d0' : '#fed7aa', background: connected ? '#f0fdf4' : '#fff7ed' }}>
          <div className="flex items-center gap-2 text-sm">
            {connected ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <XCircle className="h-4 w-4 text-orange-500" />}
            <span className={connected ? 'text-green-700' : 'text-orange-700'}>
              {connected ? 'PBX ligado' : 'PBX não confirmado — guarda as credenciais e testa a ligação'}
            </span>
          </div>
          <Server className="h-4 w-4 text-gray-400" />
        </div>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Credenciais do teu Yeastar</h2>
          <p className="text-xs text-gray-500 mb-4">
            Encontra-as no PBX em <strong>Integração → API</strong>. Precisas de ativar a OpenAPI e autorizar o
            nosso IP na allowlist.
          </p>
          <div className="flex flex-col gap-4">
            <Input
              label="Base URL do PBX"
              value={form.baseUrl}
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
              placeholder="https://a-tua-empresa.pbx.yeastarcloud.com"
              required
            />
            <Input
              label="Client ID"
              value={form.clientId}
              onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))}
              required
            />
            <Input
              label="Client Secret"
              type="password"
              value={form.clientSecret}
              onChange={(e) => setForm((f) => ({ ...f, clientSecret: e.target.value }))}
              placeholder={data?.config.secretSet ? '•••••••• (guardado — deixa vazio para manter)' : ''}
              hint={data?.config.secretSet ? 'Deixa vazio para manter o segredo actual' : undefined}
            />
            <Input
              label="Extensão de saída"
              value={form.extension}
              onChange={(e) => setForm((f) => ({ ...f, extension: e.target.value }))}
              placeholder="1000"
              hint="Extensão usada como origem nas chamadas directas"
            />

            <div className="flex items-center gap-2">
              <Button icon={<Server className="h-4 w-4" />} loading={save.isPending} onClick={() => save.mutate()}>
                Guardar
              </Button>
              <Button
                variant="outline"
                icon={<PlugZap className="h-4 w-4" />}
                loading={test.isPending}
                onClick={() => test.mutate()}
                disabled={!data?.config.baseUrl || !data?.config.clientId || !data?.config.secretSet}
              >
                Testar ligação
              </Button>
            </div>
            {(!data?.config.secretSet) && (
              <p className="text-xs text-gray-500">Guarda as credenciais primeiro para poder testar.</p>
            )}
          </div>
        </Card>

        {data?.config.webhookUrl && (
          <Card>
            <div className="flex items-center gap-2 mb-1">
              <Webhook className="h-4 w-4 text-gray-500" />
              <h2 className="text-sm font-semibold text-gray-900">Actualização em tempo real (opcional)</h2>
            </div>
            <p className="text-xs text-gray-500 mb-3">
              Para as chamadas aparecerem no CRM em segundos (sem esperar a sincronização), cola este URL no teu
              PBX em <strong>Integração → API → Webhook Event Push</strong> e ativa os eventos de chamada.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-700">
                {data.config.webhookUrl}
              </code>
              <Button
                size="sm"
                variant="outline"
                icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                onClick={copyWebhook}
              >
                {copied ? 'Copiado' : 'Copiar'}
              </Button>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
