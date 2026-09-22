import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bot, Globe, Mail, Send, StickyNote, UserRound, Paperclip, AlertTriangle, Inbox as InboxIcon, Settings2 } from 'lucide-react';
import { conversationsApi, inboxesApi, cannedApi, teamApi, apiBaseUrl, ApiError } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageSpinner } from '@/components/ui/Spinner';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { clsx, formatDate } from '@/lib/utils';
import type { Channel, Conversation, ConversationDetail, ConversationStatus } from '@/types';

const channelIcon: Record<Channel, typeof Mail> = { WEBCHAT: Globe, EMAIL: Mail, TELEGRAM: Send };

const statusColor: Record<ConversationStatus, string> = {
  OPEN: 'bg-emerald-100 text-emerald-700',
  PENDING: 'bg-amber-100 text-amber-700',
  RESOLVED: 'bg-gray-100 text-gray-600',
};

function contactLabel(c: Conversation): string {
  const ct = c.contact;
  return ct?.name || ct?.email || ct?.phone || (ct?.telegramId ? `Telegram ${ct.telegramId}` : null) || 'Visitante';
}

/**
 * Mantém a caixa em tempo real: o mesmo stream SSE do screen pop traz os
 * eventos conversation.*; aqui basta invalidar as queries e deixar o
 * react-query voltar a buscar.
 */
function useConversationEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    const token = localStorage.getItem('falai_token');
    if (!token) return;
    const es = new EventSource(`${apiBaseUrl}/tenant/events/stream?token=${encodeURIComponent(token)}`);
    const onEvent = (ev: MessageEvent<string>) => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      try {
        const { conversationId } = JSON.parse(ev.data) as { conversationId?: string };
        if (conversationId) void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      } catch {
        // payload inválido — ignora
      }
    };
    for (const e of ['conversation.created', 'conversation.message', 'conversation.updated', 'conversation.deliveryFailed']) {
      es.addEventListener(e, onEvent);
    }
    return () => es.close();
  }, [qc]);
}

export function InboxPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [status, setStatus] = useState<ConversationStatus>('OPEN');
  const [inboxId, setInboxId] = useState('');
  const [assignee, setAssignee] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useConversationEvents();

  const { data: inboxes = [] } = useQuery({ queryKey: ['inboxes'], queryFn: inboxesApi.list });
  const { data: conversations = [], isLoading } = useQuery({
    queryKey: ['conversations', status, inboxId, assignee],
    queryFn: () => conversationsApi.list({ status, inboxId: inboxId || undefined, assignee: assignee || undefined }),
  });

  return (
    <div className="flex h-screen flex-col">
      <Header
        title={t('nav.inbox')}
        actions={
          <Link to="/inbox/settings">
            <Button size="sm" variant="outline" icon={<Settings2 className="h-3.5 w-3.5" />}>{t('inbox.channels')}</Button>
          </Link>
        }
      />
      {inboxes.length === 0 && !isLoading ? (
        <EmptyState
          icon={<InboxIcon className="h-8 w-8" />}
          title={t('inbox.noInboxes')}
          description={t('inbox.noInboxesHint')}
          action={{ label: t('inbox.addChannel'), onClick: () => navigate('/inbox/settings') }}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Lista */}
          <div className="flex w-80 shrink-0 flex-col border-r border-gray-200 bg-white">
            <div className="space-y-2 border-b border-gray-200 p-3">
              <div className="flex gap-1">
                {(['OPEN', 'PENDING', 'RESOLVED'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatus(s)}
                    className={clsx('flex-1 rounded-md px-2 py-1 text-xs font-medium', status === s ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100')}
                  >
                    {t(`inbox.status.${s}`)}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <Select value={inboxId} onChange={(e) => setInboxId(e.target.value)} className="text-xs">
                  <option value="">{t('inbox.allInboxes')}</option>
                  {inboxes.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </Select>
                <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="text-xs">
                  <option value="">{t('inbox.everyone')}</option>
                  <option value="me">{t('inbox.mine')}</option>
                  <option value="none">{t('inbox.unassigned')}</option>
                </Select>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {isLoading && <PageSpinner />}
              {!isLoading && conversations.length === 0 && <p className="p-6 text-center text-sm text-gray-400">{t('inbox.empty')}</p>}
              {conversations.map((c) => {
                const Icon = channelIcon[c.inbox.channel];
                return (
                  <button
                    key={c.id}
                    onClick={() => setSelected(c.id)}
                    className={clsx('block w-full border-b border-gray-100 px-4 py-3 text-left hover:bg-gray-50', selected === c.id && 'bg-blue-50')}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                      <span className="flex-1 truncate text-sm font-medium text-gray-900">{contactLabel(c)}</span>
                      {c.mode === 'AI' && <Bot className="h-3.5 w-3.5 text-violet-500" aria-label="IA" />}
                      <span className="text-[11px] text-gray-400">{formatDate(c.lastMessageAt)}</span>
                    </div>
                    <p className="mt-1 truncate text-xs text-gray-500">
                      {c.lastMessage?.role === 'AGENT' && '↪ '}
                      {c.lastMessage?.text ?? c.subject ?? ''}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {selected ? <Thread id={selected} /> : (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-400">{t('inbox.pick')}</div>
          )}
        </div>
      )}
    </div>
  );
}

function Thread({ id }: { id: string }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: conv, isLoading } = useQuery({ queryKey: ['conversation', id], queryFn: () => conversationsApi.get(id) });
  const { data: team = [] } = useQuery({ queryKey: ['team'], queryFn: teamApi.list });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [conv?.messages.length]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['conversation', id] });
    void qc.invalidateQueries({ queryKey: ['conversations'] });
  };

  const update = useMutation({
    mutationFn: (data: { status?: string; mode?: string; assigneeId?: string | null }) =>
      conversationsApi.update(id, { ...data, updatedAt: conv!.updatedAt }),
    onSuccess: refresh,
    onError: (e) => {
      toast.error(e instanceof ApiError && e.status === 409 ? t('inbox.conflict') : t('inbox.updateError'));
      refresh();
    },
  });

  if (isLoading || !conv) return <div className="flex-1"><PageSpinner /></div>;

  const authorName = (authorId: string | null) => conv.authors.find((a) => a.id === authorId)?.name;

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col bg-gray-50">
        {/* Barra de acções */}
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-white px-4 py-2.5">
          <span className="mr-auto truncate text-sm font-semibold text-gray-900">{conv.subject || contactLabel(conv)}</span>
          <Badge className={statusColor[conv.status]}>{t(`inbox.status.${conv.status}`)}</Badge>
          <Badge className={conv.mode === 'AI' ? 'bg-violet-100 text-violet-700' : 'bg-blue-100 text-blue-700'}>
            {conv.mode === 'AI' ? t('inbox.modeAi') : t('inbox.modeHuman')}
          </Badge>
          {conv.mode === 'AI' ? (
            <Button size="sm" variant="outline" onClick={() => update.mutate({ mode: 'HUMAN', assigneeId: conv.assigneeId ?? user?.id ?? null })}>
              {t('inbox.takeOver')}
            </Button>
          ) : (
            <Button size="sm" variant="outline" icon={<Bot className="h-3.5 w-3.5" />} onClick={() => update.mutate({ mode: 'AI' })}>
              {t('inbox.giveBack')}
            </Button>
          )}
          <Select
            value={conv.assigneeId ?? ''}
            onChange={(e) => update.mutate({ assigneeId: e.target.value || null })}
            className="w-40 text-xs"
            aria-label={t('inbox.assignee')}
          >
            <option value="">{t('inbox.unassigned')}</option>
            {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          {conv.status !== 'RESOLVED' ? (
            <>
              {conv.status === 'OPEN' && (
                <Button size="sm" variant="ghost" onClick={() => update.mutate({ status: 'PENDING' })}>{t('inbox.markPending')}</Button>
              )}
              <Button size="sm" onClick={() => update.mutate({ status: 'RESOLVED' })}>{t('inbox.resolve')}</Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => update.mutate({ status: 'OPEN' })}>{t('inbox.reopen')}</Button>
          )}
        </div>

        {/* Mensagens */}
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {conv.messages.map((m) => {
            if (m.role === 'SYSTEM') {
              return (
                <div key={m.id} className="mx-auto max-w-lg rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  <p className="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-amber-700">
                    <StickyNote className="h-3 w-3" /> {t('inbox.note')} · {authorName(m.authorId)}
                  </p>
                  <p className="whitespace-pre-wrap">{m.text}</p>
                </div>
              );
            }
            const mine = m.role === 'AGENT';
            return (
              <div key={m.id} className={clsx('flex', mine ? 'justify-end' : 'justify-start')}>
                <div className={clsx('max-w-[75%] rounded-2xl px-3.5 py-2 text-sm shadow-sm', mine ? (m.authorId ? 'bg-blue-600 text-white' : 'bg-violet-600 text-white') : 'bg-white text-gray-900')}>
                  <p className="whitespace-pre-wrap break-words">{m.text}</p>
                  {m.attachments?.map((a) => (
                    <button
                      key={a.file}
                      onClick={() => void conversationsApi.openAttachment(a.file).catch(() => toast.error(t('inbox.attachmentError')))}
                      className="mt-1 flex items-center gap-1 text-xs underline"
                    >
                      <Paperclip className="h-3 w-3" /> {a.name}
                    </button>
                  ))}
                  <p className={clsx('mt-1 flex items-center gap-1 text-[10px]', mine ? 'text-white/70' : 'text-gray-400')}>
                    {mine && (m.authorId ? authorName(m.authorId) : 'IA')}
                    {mine && ' · '}
                    {formatDate(m.createdAt)}
                    {m.guardrailFlags && <AlertTriangle className="h-3 w-3" aria-label={m.guardrailFlags.join(', ')} />}
                  </p>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        <Composer conversationId={id} onSent={refresh} />
      </div>

      <ContactPanel conv={conv} />
    </>
  );
}

function Composer({ conversationId, onSent }: { conversationId: string; onSent: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [text, setText] = useState('');
  const [isNote, setIsNote] = useState(false);
  const { data: canned = [] } = useQuery({ queryKey: ['canned'], queryFn: cannedApi.list });

  // "/atalho" no início da caixa mostra as respostas rápidas que casam.
  const matches = useMemo(() => {
    const m = /^\/([\w-]*)$/.exec(text);
    return m ? canned.filter((c) => c.shortcut.startsWith(m[1]!)).slice(0, 6) : [];
  }, [text, canned]);

  const send = useMutation({
    mutationFn: () => conversationsApi.send(conversationId, text.trim(), isNote),
    onSuccess: () => {
      setText('');
      onSent();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('inbox.sendError')),
  });

  const submit = () => {
    if (text.trim() && !send.isPending) send.mutate();
  };

  return (
    <div className={clsx('relative border-t border-gray-200 p-3', isNote ? 'bg-amber-50' : 'bg-white')}>
      {matches.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          {matches.map((c) => (
            <button key={c.id} onClick={() => setText(c.text)} className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50">
              <span className="font-mono text-xs text-blue-600">/{c.shortcut}</span>
              <span className="ml-2 truncate text-gray-600">{c.text.slice(0, 80)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mb-2 flex gap-3 text-xs">
        <button onClick={() => setIsNote(false)} className={clsx('font-medium', !isNote ? 'text-blue-600' : 'text-gray-400')}>{t('inbox.reply')}</button>
        <button onClick={() => setIsNote(true)} className={clsx('font-medium', isNote ? 'text-amber-700' : 'text-gray-400')}>{t('inbox.privateNote')}</button>
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          maxLength={4000}
          placeholder={isNote ? t('inbox.notePlaceholder') : t('inbox.replyPlaceholder')}
          aria-label={t('inbox.reply')}
          className="flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500"
        />
        <Button onClick={submit} loading={send.isPending} disabled={!text.trim()} icon={<Send className="h-4 w-4" />}>
          {t('inbox.send')}
        </Button>
      </div>
    </div>
  );
}

function ContactPanel({ conv }: { conv: ConversationDetail }) {
  const { t } = useTranslation();
  const c = conv.contact;
  const rows: [string, string | null | undefined][] = [
    [t('inbox.contactEmail'), c?.email],
    [t('inbox.contactPhone'), c?.phone],
    ['Telegram', c?.telegramId],
    [t('inbox.channel'), conv.inbox.name],
    [t('inbox.assignee'), conv.assignee?.name],
  ];
  return (
    <aside className="hidden w-64 shrink-0 border-l border-gray-200 bg-white p-4 xl:block">
      <div className="mb-4 flex items-center gap-2">
        <div className="rounded-full bg-gray-100 p-2 text-gray-500"><UserRound className="h-5 w-5" /></div>
        <p className="truncate font-medium text-gray-900">{contactLabel(conv)}</p>
      </div>
      <dl className="space-y-2 text-sm">
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-gray-400">{k}</dt>
            <dd className="truncate text-gray-700">{v}</dd>
          </div>
        ))}
      </dl>
      {c && (
        <Link to={`/contacts/${c.id}`} className="mt-4 block text-sm text-blue-600 hover:underline">{t('inbox.openContact')}</Link>
      )}
    </aside>
  );
}
