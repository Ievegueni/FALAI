import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MessageSquarePlus, Send, Users } from 'lucide-react';
import { teamChatApi, type ChatRoomRow } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageSpinner } from '@/components/ui/Spinner';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { isOpsManager } from '@/lib/roles';
import { clsx, formatDate } from '@/lib/utils';

/** Nova conversa directa ou novo grupo (grupo: supervisão/gestão). */
function NewChatModal({ group, onClose, onOpen }: { group: boolean; onClose: () => void; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const { error } = useToast();
  const qc = useQueryClient();
  const { data: users = [] } = useQuery({ queryKey: ['chat', 'users'], queryFn: teamChatApi.users });
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: (userId?: string) => (group ? teamChatApi.createGroup({ name, memberIds: picked }) : teamChatApi.direct(userId!)),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['chat'] }); onOpen(r.id); onClose(); },
    onError: (e: Error) => error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={group ? t('chat.newGroup') : t('chat.newDirect')}
      footer={group ? <><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button loading={create.isPending} disabled={!name.trim() || picked.length === 0} onClick={() => create.mutate(undefined)}>{t('common.create')}</Button></> : undefined}>
      <div className="space-y-3">
        {group && <Input label={t('chat.groupName')} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />}
        <ul className="max-h-80 divide-y divide-gray-100 overflow-y-auto">
          {users.map((u) => (
            <li key={u.id}>
              {group ? (
                <label className="flex items-center gap-2 py-2 text-sm text-gray-800">
                  <input type="checkbox" checked={picked.includes(u.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, u.id] : p.filter((x) => x !== u.id)))} />
                  {u.name}
                </label>
              ) : (
                <button type="button" className="w-full py-2 text-left text-sm text-gray-800 hover:text-blue-600" onClick={() => create.mutate(u.id)}>{u.name}</button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

function Thread({ room }: { room: ChatRoomRow }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { error } = useToast();
  const [text, setText] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const { data, isLoading } = useQuery({ queryKey: ['chat', 'messages', room.id], queryFn: () => teamChatApi.messages(room.id) });

  // Abrir (ou chegar mensagem com a conversa aberta) = lida.
  useEffect(() => {
    void teamChatApi.read(room.id).then(() => qc.invalidateQueries({ queryKey: ['chat', 'unread'] }));
  }, [room.id, data?.data.length, qc]);
  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [data?.data.length]);

  const send = useMutation({
    mutationFn: () => teamChatApi.send(room.id, text.trim()),
    onSuccess: () => { setText(''); void qc.invalidateQueries({ queryKey: ['chat'] }); },
    onError: (e: Error) => error(e.message),
  });

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-gray-50">
      <div className="border-b border-gray-200 bg-white px-4 py-2.5">
        <p className="truncate text-sm font-semibold text-gray-900">{room.name}</p>
        {room.kind === 'GROUP' && <p className="truncate text-xs text-gray-500">{room.members.map((m) => m.name).join(', ')}</p>}
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {isLoading ? <PageSpinner /> : data?.data.map((m) => {
          const mine = m.authorId === user?.id;
          return (
            <div key={m.id} className={clsx('flex', mine ? 'justify-end' : 'justify-start')}>
              <div className={clsx('max-w-[75%] rounded-2xl px-3.5 py-2 text-sm shadow-sm', mine ? 'bg-blue-600 text-white' : 'bg-white text-gray-900')}>
                {!mine && room.kind === 'GROUP' && <p className="mb-0.5 text-[11px] font-medium text-blue-600">{m.author.name}</p>}
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p className={clsx('mt-1 text-[10px]', mine ? 'text-white/70' : 'text-gray-400')}>{formatDate(m.createdAt)}</p>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
      <form className="flex gap-2 border-t border-gray-200 bg-white p-3" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send.mutate(); }}>
        <textarea
          className="min-h-[40px] flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          rows={1}
          value={text}
          maxLength={4000}
          placeholder={t('chat.placeholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (text.trim()) send.mutate(); } }}
        />
        <Button type="submit" icon={<Send className="h-4 w-4" />} loading={send.isPending} disabled={!text.trim()} />
      </form>
    </div>
  );
}

export function TeamChatPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<'direct' | 'group' | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['chat', 'rooms'], queryFn: teamChatApi.rooms });
  const canGroup = isOpsManager(user?.role) || user?.role === 'SUPERVISOR';
  const room = data?.data.find((r) => r.id === selected) ?? null;

  return (
    <>
      <Header
        title={t('chat.title')}
        actions={
          <>
            {canGroup && <Button size="sm" variant="outline" icon={<Users className="h-3.5 w-3.5" />} onClick={() => setCreating('group')}>{t('chat.newGroup')}</Button>}
            <Button size="sm" icon={<MessageSquarePlus className="h-3.5 w-3.5" />} onClick={() => setCreating('direct')}>{t('chat.newDirect')}</Button>
          </>
        }
      />
      <div className="flex h-[calc(100vh-3.5rem)] min-h-0">
        <aside className={clsx('w-full shrink-0 overflow-y-auto border-r border-gray-200 bg-white sm:w-72', room && 'hidden sm:block')}>
          {isLoading ? <PageSpinner /> : data?.data.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-400">{t('chat.empty')}</p>
          ) : data?.data.map((r) => (
            <button key={r.id} type="button" onClick={() => setSelected(r.id)} className={clsx('block w-full border-b border-gray-100 px-4 py-3 text-left hover:bg-gray-50', selected === r.id && 'bg-blue-50')}>
              <div className="flex items-center gap-2">
                {r.kind === 'GROUP' && <Users className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
                <p className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">{r.name}</p>
                {r.unread > 0 && <span className="rounded-full bg-red-500 px-1.5 text-[11px] font-semibold text-white">{r.unread}</span>}
              </div>
              {r.lastMessage && <p className="mt-0.5 truncate text-xs text-gray-500">{r.kind === 'GROUP' ? `${r.lastMessage.author}: ` : ''}{r.lastMessage.body}</p>}
            </button>
          ))}
        </aside>
        {room ? <Thread room={room} /> : <div className="hidden flex-1 items-center justify-center text-sm text-gray-400 sm:flex">{t('chat.pick')}</div>}
      </div>
      {creating && <NewChatModal group={creating === 'group'} onClose={() => setCreating(null)} onOpen={setSelected} />}
    </>
  );
}
