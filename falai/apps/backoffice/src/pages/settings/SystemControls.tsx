import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCw, FlaskConical, Sparkles } from 'lucide-react';
import { settingsApi, systemApi } from '@/lib/api';
import { Button, Badge } from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Modo de teste da IA (liga/desliga) e "Reiniciar API" para aplicar as
 * configurações sem ir ao servidor. As chaves e o modo são lidos no arranque.
 */
export function SystemControls() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const [restarting, setRestarting] = useState(false);
  const isSuper = user?.role === 'SUPERADMIN';

  const { data: st } = useQuery({ queryKey: ['admin', 'system'], queryFn: systemApi.status, refetchInterval: restarting ? false : 30_000 });

  const toggle = useMutation({
    mutationFn: (stub: boolean) => settingsApi.set('AI_STUB_MODE', stub ? 'true' : 'false', false),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'system'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
      toast.success('Guardado. Reinicie a API para aplicar.');
    },
    onError: () => toast.error('Erro ao guardar.'),
  });

  const restart = async () => {
    if (!st) return;
    if (!confirm('Reiniciar a API agora?\n\nAs chamadas em curso caem e o CRM fica alguns segundos sem responder.')) return;
    setRestarting(true);
    try {
      await systemApi.restart();
      // Espera que a API volte com um arranque novo (até ~60 s).
      for (let i = 0; i < 40; i++) {
        await sleep(1500);
        const now = await systemApi.status().catch(() => null);
        if (now && now.startedAt !== st.startedAt) {
          qc.setQueryData(['admin', 'system'], now);
          toast.success('API reiniciada. Configurações aplicadas.');
          return;
        }
      }
      toast.error('A API não reiniciou. Verifique o servidor (pm2 / tsx watch).');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Erro ao reiniciar.');
    } finally {
      setRestarting(false);
    }
  };

  if (!st) return null;
  const real = !st.running.aiStubMode && st.running.anthropicConfigured;
  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-500">IA em uso agora:</span>
          {real ? (
            <Badge className="bg-emerald-100 text-emerald-700"><Sparkles className="mr-1 h-3 w-3" />Claude real</Badge>
          ) : (
            <Badge className="bg-amber-100 text-amber-800">
              <FlaskConical className="mr-1 h-3 w-3" />
              Modo de teste{!st.running.anthropicConfigured && !st.running.aiStubMode ? ' (sem chave)' : ''}
            </Badge>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <button
            type="button"
            role="switch"
            aria-checked={st.saved.aiStubMode}
            disabled={toggle.isPending || restarting}
            onClick={() => toggle.mutate(!st.saved.aiStubMode)}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${st.saved.aiStubMode ? 'bg-amber-500' : 'bg-gray-300'}`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${st.saved.aiStubMode ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
          Modo de teste da IA
          <span className="text-xs text-gray-400">(chamadas e análise dos relatórios sem chamar Claude, Deepgram nem ElevenLabs)</span>
        </label>

        <div className="ml-auto flex items-center gap-3">
          {st.pendingRestart && <Badge className="bg-indigo-100 text-indigo-700">Alterações por aplicar</Badge>}
          <Button
            size="sm"
            variant={st.pendingRestart ? 'primary' : 'outline'}
            icon={<RotateCw className={`h-3.5 w-3.5 ${restarting ? 'animate-spin' : ''}`} />}
            disabled={!isSuper || restarting}
            title={isSuper ? undefined : 'Só SUPERADMIN pode reiniciar a API'}
            onClick={() => void restart()}
          >
            {restarting ? 'A reiniciar…' : 'Reiniciar API'}
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-gray-400">
        Arrancou em {new Date(st.startedAt).toLocaleString('pt-PT')}. As chaves e o modo de teste aplicam-se ao reiniciar.
      </p>
    </div>
  );
}
