import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { teamChatApi, type ChatMessageRow } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';

export type ChatEvent = { roomId: string; roomName: string | null; message: ChatMessageRow };

/** Mensagens novas: actualiza listas e avisa no ecrã quando não se está no chat. */
export function ChatToaster() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user, tenant } = useAuth();
  const { pathname } = useLocation();
  const enabled = tenant?.features?.teamChat === true;
  useEffect(() => {
    if (!enabled) return;
    const on = (ev: Event) => {
      const d = (ev as CustomEvent<ChatEvent>).detail;
      void qc.invalidateQueries({ queryKey: ['chat'] });
      if (d.message.authorId !== user?.id && !pathname.startsWith('/chat')) {
        toast.info(`${d.roomName ? `${d.roomName} · ` : ''}${d.message.author.name}: ${d.message.body.slice(0, 80)}`);
      }
    };
    window.addEventListener('falai:chat', on);
    return () => window.removeEventListener('falai:chat', on);
  }, [qc, toast, user?.id, pathname, enabled]);
  return null;
}

/** Contador de não lidas no menu. */
export function ChatUnreadBadge({ wide }: { wide: boolean }) {
  const { tenant } = useAuth();
  const { data } = useQuery({ queryKey: ['chat', 'unread'], queryFn: teamChatApi.unread, enabled: tenant?.features?.teamChat === true, refetchInterval: 60_000 });
  if (!data?.total) return null;
  return (
    <span className={wide ? 'ml-auto rounded-full bg-red-500 px-1.5 text-[11px] font-semibold text-white' : 'absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500'}>
      {wide ? data.total : ''}
    </span>
  );
}
