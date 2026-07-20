import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { ArrowLeft, PhoneCall, PhoneOff, Info } from 'lucide-react';
import { callsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';

export function DirectCallPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { success, error } = useToast();

  // Número pré-preenchido quando se vem do botão rápido de um contacto
  const prefillTo = (location.state as { to?: string } | null)?.to ?? '';

  const [fromExtension, setFromExtension] = useState('');
  const [to, setTo] = useState(prefillTo);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);

  const { data: extensions, isLoading: loadingExt } = useQuery({
    queryKey: ['extensions'],
    queryFn: callsApi.extensions,
  });

  // Selecciona a primeira extensão por defeito assim que a lista chega
  useEffect(() => {
    const first = extensions?.[0];
    if (!fromExtension && first) {
      setFromExtension(first.number);
    }
  }, [extensions, fromExtension]);

  const dial = useMutation({
    mutationFn: () => callsApi.direct({ fromExtension, to }),
    onSuccess: (res) => {
      setActiveCallId(res.providerCallId);
      success(`Chamada iniciada da extensão ${fromExtension} para ${to}`);
    },
    onError: (e: Error) => error(e.message),
  });

  const hangup = useMutation({
    mutationFn: () => callsApi.directHangup(activeCallId!),
    onSuccess: () => {
      setActiveCallId(null);
      success('Chamada terminada');
    },
    onError: (e: Error) => error(e.message),
  });

  // Polling: detecta quando o cliente (ou o PBX) desliga a chamada sem acção do operador
  useEffect(() => {
    if (!activeCallId) return;
    const id = setInterval(async () => {
      try {
        const { active } = await callsApi.directStatus(activeCallId);
        if (!active) {
          setActiveCallId(null);
          success('Chamada terminada pelo outro lado');
        }
      } catch {
        // ignora erros de rede transientes
      }
    }, 4000);
    return () => clearInterval(id);
  }, [activeCallId, success]);

  function handleDial() {
    if (!fromExtension) { error('Seleccione a extensão de origem'); return; }
    if (!to.trim()) { error('Indique o número de destino'); return; }
    dial.mutate();
  }

  if (loadingExt) return <><Header title="Chamada directa" /><PageSpinner /></>;

  return (
    <>
      <Header
        title="Chamada directa"
        actions={
          <Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => navigate('/calls')}>
            Voltar
          </Button>
        }
      />

      <div className="p-6 max-w-xl space-y-6">
        <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 flex items-start gap-3">
          <Info className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-blue-700">
            Chamada normal do PBX, sem agente de IA. Toca primeiro a <strong>extensão de origem</strong> e,
            quando esta atende, liga ao número de destino. A extensão precisa de ter um telefone/softphone registado.
          </div>
        </div>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Configurar chamada</h2>
          <div className="flex flex-col gap-4">
            {!loadingExt && (extensions?.length ?? 0) === 0 ? (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
                Ainda não há nenhuma linha activa associada a esta conta. Contacte o suporte para configurar a sua linha de chamadas.
              </div>
            ) : (
              <Select
                label="Extensão de origem"
                value={fromExtension}
                onChange={(e) => setFromExtension(e.target.value)}
                disabled={!!activeCallId || loadingExt}
                required
              >
                {(extensions ?? []).map((ext) => (
                  <option key={ext.number} value={ext.number}>
                    {ext.number}{ext.name && ext.name !== ext.number ? ` — ${ext.name}` : ''}
                  </option>
                ))}
              </Select>
            )}

            <Input
              label="Número de destino"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="+244 9XX XXX XXX"
              hint="Número externo ou outra extensão"
              disabled={!!activeCallId}
              required
            />

            {activeCallId ? (
              <div className="flex flex-col gap-3">
                <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
                  Chamada em curso · ID PBX: <strong>{activeCallId}</strong>
                </div>
                <Button
                  variant="danger"
                  icon={<PhoneOff className="h-4 w-4" />}
                  loading={hangup.isPending}
                  onClick={() => hangup.mutate()}
                >
                  Desligar chamada
                </Button>
              </div>
            ) : (
              <Button
                icon={<PhoneCall className="h-4 w-4" />}
                loading={dial.isPending}
                onClick={handleDial}
              >
                Ligar agora
              </Button>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
