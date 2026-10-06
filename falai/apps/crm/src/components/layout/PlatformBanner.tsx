import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { platformApi } from '@/lib/api';

/**
 * Faixa no topo quando um componente da plataforma está em baixo (fase 11):
 * telefonia, registo na operadora, base de dados... Actualiza-se pelo canal em
 * tempo real e, por segurança, a cada minuto.
 */
export function PlatformBanner() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['platform-status'], queryFn: platformApi.status, refetchInterval: 60_000, retry: false });
  useEffect(() => {
    const on = () => void qc.invalidateQueries({ queryKey: ['platform-status'] });
    window.addEventListener('falai:platform', on);
    return () => window.removeEventListener('falai:platform', on);
  }, [qc]);
  const down = data?.components.filter((c) => !c.up) ?? [];
  if (down.length === 0) return null;
  return (
    <div className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800" role="alert">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        {down.map((c) => t(`platform.down.${c.key.startsWith('peer:') ? 'peer' : c.key}`, { defaultValue: t('platform.down.other') })).join(' ')}
        {' '}{t('platform.notified')}
      </span>
    </div>
  );
}
