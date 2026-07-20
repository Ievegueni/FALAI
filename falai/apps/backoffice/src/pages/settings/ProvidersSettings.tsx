import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Phone, Mic, Bot, Volume2, CreditCard, MessageSquare, Save } from 'lucide-react';
import type { ReactNode } from 'react';
import { settingsApi } from '@/lib/api';
import { Card, Button, Input } from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';

type FieldType = 'text' | 'secret' | 'bool';

interface Field {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  hint?: string;
}

interface Section {
  title: string;
  subtitle: string;
  icon: ReactNode;
  fields: Field[];
}

const SECTIONS: Section[] = [
  {
    title: 'Telefonia — Yeastar PBX',
    subtitle: 'Ligação à OpenAPI do PBX (faz e recebe as chamadas)',
    icon: <Phone className="h-5 w-5" />,
    fields: [
      { key: 'YEASTAR_BASE_URL', label: 'Base URL', type: 'text', placeholder: 'https://a-tua-empresa.yeastar.cloud' },
      { key: 'YEASTAR_CLIENT_ID', label: 'Client ID', type: 'text' },
      { key: 'YEASTAR_CLIENT_SECRET', label: 'Client Secret', type: 'secret' },
      { key: 'YEASTAR_STUB_MODE', label: 'Modo stub (sem chamadas reais)', type: 'bool', hint: 'Deixa "Ligado" enquanto testas sem PBX. Muda para "Desligado" para chamadas reais.' },
    ],
  },
  {
    title: 'Reconhecimento de voz — Deepgram',
    subtitle: 'Transcrição de fala (STT)',
    icon: <Mic className="h-5 w-5" />,
    fields: [{ key: 'DEEPGRAM_API_KEY', label: 'API Key', type: 'secret' }],
  },
  {
    title: 'Modelo de linguagem — Anthropic',
    subtitle: 'Cérebro conversacional (LLM)',
    icon: <Bot className="h-5 w-5" />,
    fields: [{ key: 'ANTHROPIC_API_KEY', label: 'API Key', type: 'secret' }],
  },
  {
    title: 'Síntese de voz — ElevenLabs',
    subtitle: 'Geração de voz (TTS)',
    icon: <Volume2 className="h-5 w-5" />,
    fields: [
      { key: 'ELEVENLABS_API_KEY', label: 'API Key', type: 'secret' },
      { key: 'ELEVENLABS_DEFAULT_VOICE_ID', label: 'Voice ID por defeito', type: 'text', placeholder: '21m00Tcm4TlvDq8ikWAM' },
    ],
  },
  {
    title: 'Pagamentos — ProxyPay',
    subtitle: 'Referências Multicaixa / recargas',
    icon: <CreditCard className="h-5 w-5" />,
    fields: [{ key: 'PROXYPAY_API_KEY', label: 'API Key', type: 'secret' }],
  },
  {
    title: 'SMS — Futurix',
    subtitle: 'Envio de SMS',
    icon: <MessageSquare className="h-5 w-5" />,
    fields: [{ key: 'FUTURIX_SMS_API_KEY', label: 'API Key', type: 'secret' }],
  },
];

export const PROVIDER_KEYS = SECTIONS.flatMap((s) => s.fields.map((f) => f.key));
const ALL_KEYS = PROVIDER_KEYS;
const isSecretKey = (key: string) =>
  SECTIONS.some((s) => s.fields.some((f) => f.key === key && f.type === 'secret'));

export function ProvidersSettings() {
  const qc = useQueryClient();
  const toast = useToast();

  const { data: settings } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => settingsApi.list(),
  });

  // Mapa key → { value, isSecret } para os valores actuais.
  const current = useMemo(() => {
    const map = new Map<string, { value: string; isSecret: boolean }>();
    (settings ?? []).forEach((s) => map.set(s.key, { value: s.value, isSecret: s.isSecret }));
    return map;
  }, [settings]);

  // Valores do formulário (só para os campos deste ecrã).
  const [form, setForm] = useState<Record<string, string>>({});

  // Valor mostrado: o que o utilizador escreveu, ou o actual para não-secretos.
  const displayValue = (f: Field): string => {
    if (form[f.key] !== undefined) return form[f.key]!;
    if (f.type === 'secret') return ''; // nunca prefill de segredos (vêm mascarados)
    if (f.type === 'bool') return current.get(f.key)?.value ?? 'true';
    return current.get(f.key)?.value ?? '';
  };

  const isConfigured = (key: string) => current.has(key) && (current.get(key)?.value ?? '') !== '';

  const saveMut = useMutation({
    mutationFn: async () => {
      const changed = ALL_KEYS.filter((key) => {
        const typed = form[key];
        if (typed === undefined) return false; // não tocado
        if (isSecretKey(key)) return typed.trim() !== ''; // só grava segredo se escreveram algo
        return typed !== (current.get(key)?.value ?? ''); // não-secreto: só se mudou
      });
      await Promise.all(changed.map((key) => settingsApi.set(key, form[key]!, isSecretKey(key))));
      return changed.length;
    },
    onSuccess: (count) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
      setForm({});
      toast.success(count === 0 ? 'Nada para guardar.' : `${count} chave(s) actualizada(s). Reinicia a API para aplicar.`);
    },
    onError: () => toast.error('Erro ao guardar as chaves.'),
  });

  return (
    <Card>
      <div className="flex items-start justify-between mb-1">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Provedores &amp; Integrações</h2>
          <p className="text-sm text-gray-500">Chaves de API dos serviços externos. Segredos são encriptados; alterações aplicam-se após reiniciar a API.</p>
        </div>
        <Button icon={<Save className="h-4 w-4" />} loading={saveMut.isPending} onClick={() => saveMut.mutate()}>
          Guardar alterações
        </Button>
      </div>

      <div className="mt-5 space-y-8">
        {SECTIONS.map((section) => (
          <div key={section.title}>
            <div className="flex items-center gap-2 mb-3 text-gray-700">
              <span className="text-indigo-600">{section.icon}</span>
              <div>
                <h3 className="text-sm font-semibold">{section.title}</h3>
                <p className="text-xs text-gray-400">{section.subtitle}</p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {section.fields.map((f) => {
                if (f.type === 'bool') {
                  return (
                    <div key={f.key}>
                      <label className="mb-1 block text-sm font-medium text-gray-700">{f.label}</label>
                      <select
                        value={displayValue(f)}
                        onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      >
                        <option value="true">Ligado</option>
                        <option value="false">Desligado</option>
                      </select>
                      {f.hint && <p className="mt-1 text-xs text-gray-400">{f.hint}</p>}
                    </div>
                  );
                }
                const secret = f.type === 'secret';
                return (
                  <Input
                    key={f.key}
                    label={f.label}
                    type={secret ? 'password' : 'text'}
                    autoComplete="off"
                    placeholder={secret && isConfigured(f.key) ? '•••••••••• configurado (deixar vazio para manter)' : f.placeholder}
                    hint={f.hint ?? (secret && isConfigured(f.key) ? 'Já configurado. Escreve para substituir.' : undefined)}
                    value={displayValue(f)}
                    onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
