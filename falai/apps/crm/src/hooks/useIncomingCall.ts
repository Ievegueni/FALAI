import { useEffect, useState } from 'react';
import { callersApi } from '@/lib/api';
import { useTenantEvents } from '@/lib/tenantEvents';
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
 * Chamada a entrar mais recente para o "screen pop" (stream SSE partilhado,
 * lib/tenantEvents.ts). Só aparece a quem a chamada está a tocar — a extensão
 * do utilizador; supervisores acompanham pela Supervisão — e fecha quando a
 * chamada termina. Faz automaticamente a procura do contacto pelo número.
 */
export function useIncomingCall(): { call: IncomingCall | null; dismiss: () => void } {
  const { user } = useAuth();
  const [call, setCall] = useState<IncomingCall | null>(null);
  const myNumber = user?.extensionNumber ?? null;

  useEffect(() => {
    if (!user) setCall(null);
  }, [user]);

  useTenantEvents<IncomingCall>(['incoming-call'], (data) => {
    if (!myNumber || data.calleeNumber !== myNumber) return;
    setCall({ ...data, contact: undefined });
    void resolveContact(data.callerNumber).then((contact) => {
      setCall((cur) =>
        cur && cur.callerNumber === data.callerNumber && cur.at === data.at ? { ...cur, contact } : cur,
      );
    });
  }, !!user);

  // Fim da chamada (ou atendida noutra extensão): fecha o pop dessa chamada.
  useTenantEvents<{ callId: string | null }>(['incoming-call.ended'], (data) => {
    setCall((cur) => (cur && cur.callId === data.callId ? null : cur));
  }, !!user);

  // Alertas operacionais (a API só os manda à supervisão): reenviados como
  // evento da janela para o AlertToaster e quem mostra a lista se actualizar.
  // O estado da plataforma (fase 11) segue o mesmo caminho: a faixa de aviso escuta-o.
  useTenantEvents(['platform.status'], () => window.dispatchEvent(new CustomEvent('falai:platform')), !!user);
  // Chat interno: a API só manda aos membros da conversa.
  useTenantEvents(['chat.message'], (data) => window.dispatchEvent(new CustomEvent('falai:chat', { detail: data })), !!user);
  useTenantEvents(['alert.opened', 'alert.closed'], (data, name) => {
    window.dispatchEvent(new CustomEvent('falai:alert', { detail: { name, data } }));
  }, !!user);

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
