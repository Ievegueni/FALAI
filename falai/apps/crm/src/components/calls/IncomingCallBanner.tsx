import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PhoneIncoming, User, X } from 'lucide-react';
import { useIncomingCall } from '@/hooks/useIncomingCall';
import { formatPhone } from '@/lib/utils';

/**
 * Banner de "screen pop": aparece no topo do CRM assim que uma chamada dá
 * entrada no PBX. Mostra o número (e o nome do contacto, se conhecido) e permite
 * abrir de imediato a ficha do contacto.
 */
export function IncomingCallBanner() {
  const { call, dismiss } = useIncomingCall();
  const { t } = useTranslation();
  const navigate = useNavigate();

  if (!call) return null;

  const contact = call.contact;
  const openContact = () => {
    if (contact) navigate(`/contacts/${contact.id}`);
    else navigate(`/contacts?search=${encodeURIComponent(call.callerNumber)}`);
    dismiss();
  };

  return (
    <div className="fixed top-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2">
      <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-white p-4 shadow-lg ring-1 ring-emerald-500/10">
        <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-100">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-60" />
          <PhoneIncoming className="relative h-5 w-5 text-emerald-600" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-emerald-600">
            {t('incomingCall.title')}
          </p>
          <p className="truncate text-sm font-semibold text-gray-900">
            {contact ? contact.name : formatPhone(call.callerNumber)}
          </p>
          {contact && (
            <p className="truncate text-xs text-gray-400">{formatPhone(call.callerNumber)}</p>
          )}
          {contact === null && (
            <p className="truncate text-xs text-gray-400">{t('incomingCall.unknownContact')}</p>
          )}
        </div>

        <button
          onClick={openContact}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-700"
        >
          <User className="h-4 w-4" />
          {contact ? t('incomingCall.open') : t('incomingCall.find')}
        </button>

        <button
          onClick={dismiss}
          aria-label={t('common.close')}
          className="shrink-0 rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
