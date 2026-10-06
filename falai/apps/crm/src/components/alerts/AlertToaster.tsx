import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/contexts/ToastContext';
import type { OpsAlert } from '@/lib/api';
import { alertText } from './alertText';

/** Aviso no ecrã quando abre um alerta operacional; mantém as listas em dia. */
export function AlertToaster() {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  useEffect(() => {
    const onAlert = (ev: Event) => {
      const { name, data } = (ev as CustomEvent<{ name: string; data: OpsAlert }>).detail;
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      if (name === 'alert.opened') toast.warning(alertText(t, data));
    };
    window.addEventListener('falai:alert', onAlert);
    return () => window.removeEventListener('falai:alert', onAlert);
  }, [qc, t, toast]);
  return null;
}
