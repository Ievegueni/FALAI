import { useEffect, useRef, useState } from 'react';
import { apiBaseUrl, callersApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

export interface IncomingCall {
  callId: string | null;
  callerNumber: string;
  calleeNumber: string | null;
  at: string;
  /** Contacto correspondente ao número (se existir na base). Resolvido de forma assíncrona. */
  contact?: { id: string; name: string | null } | null;
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

    // Alertas operacionais (a API só os manda à supervisão): reenviados como
    // evento da janela para o AlertToaster e quem mostra a lista se actualizar.
    // O estado da plataforma (fase 11) segue o mesmo caminho: a faixa de aviso escuta-o.
    es.addEventListener('platform.status', () => window.dispatchEvent(new CustomEvent('falai:platform')));
    for (const name of ['alert.opened', 'alert.closed']) {
      es.addEventListener(name, (ev: MessageEvent<string>) => {
        try {
          window.dispatchEvent(new CustomEvent('falai:alert', { detail: { name, data: JSON.parse(ev.data) } }));
        } catch {
          // payload inválido — ignora
        }
      });
    }

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [user]);

  return { call, dismiss: () => setCall(null) };
}

/**
 * Contacto do número, pela pesquisa do servidor (normalizada e indexada — a
 * mesma do painel do webphone). Também regista o acesso no AuditLog.
 */
async function resolveContact(phone: string): Promise<{ id: string; name: string | null } | null> {
  try {
    const panel = await callersApi.lookup({ number: phone });
    return panel.contact ? { id: panel.contact.id, name: panel.contact.name } : null;
  } catch {
    return null;
  }
}
