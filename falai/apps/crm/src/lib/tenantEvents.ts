import { useEffect, useRef } from 'react';
import { apiBaseUrl } from '@/lib/api';

/**
 * Um único EventSource por separador para /tenant/events/stream, partilhado por
 * quem subscreve (screen pop, webphone, caixa de entrada…). Abre com o primeiro
 * subscritor e fecha com o último.
 */
type Listener = (ev: MessageEvent<string>) => void;

const listeners = new Map<string, Set<Listener>>();
let es: EventSource | null = null;
let esToken: string | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function open(): void {
  const token = localStorage.getItem('falai_token');
  if (!token) return;
  const src = new EventSource(`${apiBaseUrl}/tenant/events/stream?token=${encodeURIComponent(token)}`);
  es = src;
  esToken = token;
  for (const [name, set] of listeners) for (const l of set) src.addEventListener(name, l);
  // Um erro HTTP (ex.: 502 do nginx enquanto a API reinicia) fecha o
  // EventSource de vez — só a queda de rede é que ele repete sozinho.
  src.onerror = () => {
    if (src.readyState !== EventSource.CLOSED || es !== src) return;
    es = null;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (!es && listeners.size > 0) open();
    }, 5000);
  };
}

function close(): void {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  es?.close();
  es = null;
  esToken = null;
}

export function subscribeTenantEvent(name: string, listener: Listener): () => void {
  let set = listeners.get(name);
  if (!set) listeners.set(name, (set = new Set()));
  set.add(listener);
  // Outra sessão (novo login) neste separador: reabre com o token actual.
  if (es && esToken !== localStorage.getItem('falai_token')) close();
  if (es) es.addEventListener(name, listener);
  else if (!retryTimer) open();
  return () => {
    set.delete(listener);
    es?.removeEventListener(name, listener);
    if (set.size === 0) listeners.delete(name);
    if (listeners.size === 0) close();
  };
}

/** Subscreve eventos SSE do tenant; o handler recebe o `data` já em JSON. */
export function useTenantEvents<T = unknown>(
  names: string[],
  handler: (data: T, name: string) => void,
  enabled = true,
): void {
  const ref = useRef(handler);
  ref.current = handler;
  const key = names.join(',');
  useEffect(() => {
    if (!enabled) return;
    const offs = key.split(',').map((name) =>
      subscribeTenantEvent(name, (ev) => {
        let data: T;
        try {
          data = JSON.parse(ev.data) as T;
        } catch {
          return; // payload inválido — ignora
        }
        ref.current(data, name);
      }),
    );
    return () => offs.forEach((off) => off());
  }, [key, enabled]);
}
