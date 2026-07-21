import { useEffect, useRef, useState } from 'react';
import { apiBaseUrl, contactsApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import type { Contact } from '@/types';

export interface IncomingCall {
  callId: string | null;
  callerNumber: string;
  calleeNumber: string | null;
  at: string;
  /** Contacto correspondente ao número (se existir na base). Resolvido de forma assíncrona. */
  contact?: Contact | null;
}

/**
 * Liga-se ao stream SSE da API e devolve a chamada a entrar mais recente
 * (para o "screen pop"). Faz automaticamente a procura do contacto pelo número.
 *
 * O EventSource reconecta sozinho em caso de queda de rede. Fecha quando o
 * utilizador termina a sessão.
 */
export function useIncomingCall(): { call: IncomingCall | null; dismiss: () => void } {
  const { user } = useAuth();
  const [call, setCall] = useState<IncomingCall | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!user) {
      esRef.current?.close();
      esRef.current = null;
      setCall(null);
      return;
    }

    const token = localStorage.getItem('falai_token');
    if (!token) return;

    const url = `${apiBaseUrl}/tenant/events/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('incoming-call', (ev: MessageEvent<string>) => {
      try {
        const data = JSON.parse(ev.data) as IncomingCall;
        setCall({ ...data, contact: undefined });
        void resolveContact(data.callerNumber).then((contact) => {
          setCall((cur) =>
            cur && cur.callerNumber === data.callerNumber && cur.at === data.at ? { ...cur, contact } : cur,
          );
        });
      } catch {
        // payload inválido — ignora
      }
    });

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [user]);

  return { call, dismiss: () => setCall(null) };
}

/** Procura um contacto cujo telefone corresponda ao número recebido. */
async function resolveContact(phone: string): Promise<Contact | null> {
  try {
    const res = await contactsApi.list({ search: phone });
    const digits = onlyDigits(phone);
    return (
      res.data.find((c) => onlyDigits(c.phone) === digits || onlyDigits(c.phone).endsWith(digits)) ??
      res.data[0] ??
      null
    );
  } catch {
    return null;
  }
}

function onlyDigits(v: string): string {
  return v.replace(/\D/g, '');
}
