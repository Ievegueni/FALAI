import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PhoneOutgoing } from 'lucide-react';
import { queueApi, type QueueCallback } from '@/lib/api';
import { useTenantEvents } from '@/lib/tenantEvents';
import { useAuth } from '@/contexts/AuthContext';
import { useWebphone } from '@/contexts/WebphoneContext';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { formatPhone } from '@/lib/utils';
import { playQueueAlert } from '@/lib/ringtone';

const AUTO_DIAL_SECS = 10;

/**
 * Callback da fila entregue a este agente (services/callQueue.service.ts).
 * Com o webphone registado e livre, liga sozinho ao fim de AUTO_DIAL_SECS;
 * no fim o agente diz como correu ("não atendeu" volta à fila).
 */
export function CallbackPopup() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { registration, callState, call } = useWebphone();
  const { error } = useToast();
  const [cb, setCb] = useState<QueueCallback | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [dialed, setDialed] = useState(false);
  const [busy, setBusy] = useState(false);

  const show = (c: QueueCallback | null) => {
    setCb(c);
    setDialed(false);
    setLeft(c ? AUTO_DIAL_SECS : null);
  };

  // Ao abrir o CRM: algum que já me estava entregue.
  useEffect(() => {
    if (user) void queueApi.mine().then((r) => show(r.data)).catch(() => {});
  }, [user]);
  useTenantEvents<QueueCallback>(['queue-callback'], (d) => {
    playQueueAlert();
    show(d);
  }, !!user);

  const canDial = registration === 'registered' && callState === 'idle';
  const dial = () => {
    if (!cb) return;
    setLeft(null);
    setDialed(true);
    call(cb.number);
  };

  // Contagem para a marcação automática; pára se o agente estiver ocupado.
  useEffect(() => {
    if (left === null || dialed || !cb) return;
    if (!canDial) return;
    if (left <= 0) {
      dial();
      return;
    }
    const id = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, dialed, cb, canDial]);

  const close = async (result: 'DONE' | 'NO_ANSWER' | 'CANCELLED') => {
    if (!cb) return;
    setBusy(true);
    try {
      await queueApi.result(cb.id, result);
      show(null);
    } catch (e) {
      error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!cb) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 rounded-xl border border-amber-200 bg-white p-4 shadow-lg">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <PhoneOutgoing className="h-4 w-4 text-amber-600" />
        {t('queue.popup.title')}
      </div>
      <p className="mt-2 text-lg font-semibold text-gray-900">{cb.contact?.name ?? formatPhone(cb.number)}</p>
      {cb.contact?.name && <p className="text-sm text-gray-600">{formatPhone(cb.number)}</p>}
      <p className="mt-1 text-xs text-gray-500">
        {t('queue.popup.requestedAt', { time: new Date(cb.createdAt).toLocaleTimeString() })}
        {cb.attempts > 0 && ` · ${t('queue.popup.attempt', { n: cb.attempts + 1 })}`}
      </p>
      {!dialed && (
        <p className="mt-2 text-xs text-amber-700">
          {left === null ? t('queue.popup.paused') : canDial ? t('queue.popup.autoDial', { secs: left }) : t('queue.popup.waitingPhone')}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {!dialed ? (
          <>
            <Button size="sm" onClick={dial} disabled={!canDial}>{t('queue.popup.callNow')}</Button>
            <Button size="sm" variant="outline" onClick={() => setLeft(null)}>{t('queue.popup.hold')}</Button>
          </>
        ) : (
          <>
            <Button size="sm" loading={busy} onClick={() => void close('DONE')}>{t('queue.popup.done')}</Button>
            <Button size="sm" variant="outline" loading={busy} onClick={() => void close('NO_ANSWER')}>{t('queue.popup.noAnswer')}</Button>
          </>
        )}
        <Button size="sm" variant="ghost" loading={busy} onClick={() => void close('CANCELLED')}>{t('queue.popup.cancel')}</Button>
      </div>
    </div>
  );
}
