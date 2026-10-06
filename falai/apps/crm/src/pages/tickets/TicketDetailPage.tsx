import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Hand, MessageSquare, Pencil, Phone, StickyNote, Unlink, User } from 'lucide-react';
import { ApiError, ticketsApi, type TicketInput } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageSpinner } from '@/components/ui/Spinner';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { formatDate, formatDuration, formatPhone } from '@/lib/utils';
import {
  Field,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TicketPriorityBadge,
  TicketStatusBadge,
  categoryTree,
  selectCls,
  useTicketMeta,
} from '@/components/tickets/TicketBits';
import type { TicketDetail, TicketMeta, TicketStatus } from '@/types';
import { KbQuickSearch } from '@/components/knowledge/KbBits';

export function TicketDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState<{ subject: string; description: string } | null>(null);

  const { data: ticket, isLoading } = useQuery({ queryKey: ['tickets', id], queryFn: () => ticketsApi.get(id!) });
  const { data: meta } = useTicketMeta();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['tickets'] });

  const update = useMutation({
    mutationFn: (data: TicketInput & { status?: TicketStatus }) => ticketsApi.update(id!, { ...data, updatedAt: ticket!.updatedAt }),
    onSuccess: () => { setEditing(null); refresh(); },
    onError: (e: Error) => {
      toast.error(e instanceof ApiError && e.status === 409 ? t('tickets.conflict') : e.message);
      refresh();
    },
  });
  const addNote = useMutation({
    mutationFn: () => ticketsApi.addNote(id!, note.trim()),
    onSuccess: () => { setNote(''); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const unlink = useMutation({
    mutationFn: (target: { callId?: string; conversationId?: string }) => ticketsApi.unlink(id!, target),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <><Header title={t('tickets.title')} /><PageSpinner /></>;
  if (!ticket) return <><Header title={t('tickets.title')} /><div className="p-6 text-sm text-gray-500">{t('tickets.notFound')}</div></>;

  const locked = !ticket.canEdit;
  // Agente: pega num ticket da fila (atribui-se) e só atribui a si ou à fila.
  const isAgent = user?.role === 'MEMBER';
  const canTake = isAgent && !ticket.assigneeId && ticket.status !== 'CLOSED';
  const assignees = isAgent ? (meta?.users ?? []).filter((u) => u.id === user?.id) : meta?.users ?? [];
  const tree = categoryTree(meta);
  const subs = tree.find((c) => c.id === ticket.categoryId)?.subs ?? [];

  return (
    <>
      <Header
        title={`${t('tickets.ticket')} #${ticket.number}`}
        actions={
          <Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => navigate('/tickets')}>
            {t('common.back')}
          </Button>
        }
      />

      <div className="grid max-w-6xl gap-6 p-4 sm:p-6 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-lg font-semibold text-gray-900">{ticket.subject}</h1>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <TicketStatusBadge status={ticket.status} />
                  <TicketPriorityBadge priority={ticket.priority} />
                  <span className="text-xs text-gray-400">
                    {t('tickets.levelN', { n: ticket.supportLevel })} · {t(`tickets.source.${ticket.source}`, { defaultValue: ticket.source })} · {formatDate(ticket.createdAt)}
                    {ticket.reopenCount > 0 && ` · ${t('tickets.reopened', { count: ticket.reopenCount })}`}
                  </span>
                </div>
              </div>
              {canTake && (
                <Button size="sm" icon={<Hand className="h-3.5 w-3.5" />} loading={update.isPending} onClick={() => update.mutate({ assigneeId: user!.id })}>
                  {t('tickets.take')}
                </Button>
              )}
              {!locked && (
                <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing({ subject: ticket.subject, description: ticket.description ?? '' })}>
                  {t('common.edit')}
                </Button>
              )}
            </div>
            {ticket.description && <p className="mt-4 whitespace-pre-wrap text-sm text-gray-700">{ticket.description}</p>}
          </Card>

          {/* Linha do tempo */}
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-gray-900">{t('tickets.timeline')}</h2>
            <ol className="space-y-3">
              {ticket.events.map((e) => (
                <li key={e.id} className="flex gap-3 text-sm">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gray-300" />
                  <div className="min-w-0 flex-1">
                    {e.type === 'NOTE' ? (
                      <div className="rounded-lg bg-yellow-50 px-3 py-2">
                        <p className="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-amber-700"><StickyNote className="h-3 w-3" /> {t('tickets.note')}</p>
                        <p className="whitespace-pre-wrap text-gray-800">{e.body}</p>
                      </div>
                    ) : (
                      <p className="text-gray-700">{describeEvent(e, meta, t)}</p>
                    )}
                    <p className="mt-0.5 text-xs text-gray-400">{[e.author?.name ?? t('tickets.system'), formatDate(e.createdAt)].join(' · ')}</p>
                  </div>
                </li>
              ))}
            </ol>
            {!locked && (
              <form className="mt-4 space-y-2" onSubmit={(ev) => { ev.preventDefault(); if (note.trim()) addNote.mutate(); }}>
                <Textarea value={note} onChange={(ev) => setNote(ev.target.value)} rows={3} maxLength={10000} placeholder={t('tickets.notePlaceholder')} />
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={!note.trim()} loading={addNote.isPending}>{t('tickets.addNote')}</Button>
                </div>
              </form>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <div className="flex flex-col gap-3">
              <Field label={t('tickets.statusLabel')}>
                <select className={selectCls} value={ticket.status} disabled={locked} onChange={(e) => update.mutate({ status: e.target.value as TicketStatus })}>
                  {TICKET_STATUSES.map((s) => <option key={s} value={s}>{t(`tickets.status.${s}`)}</option>)}
                </select>
              </Field>
              <Field label={t('tickets.priorityLabel')}>
                <select className={selectCls} value={ticket.priority} disabled={locked} onChange={(e) => update.mutate({ priority: e.target.value as TicketDetail['priority'] })}>
                  {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{t(`tickets.priority.${p}`)}</option>)}
                </select>
              </Field>
              <Field label={t('tickets.level')}>
                <select className={selectCls} value={ticket.supportLevel} disabled={locked} onChange={(e) => update.mutate({ supportLevel: Number(e.target.value) })}>
                  {[1, 2, 3].map((l) => <option key={l} value={l}>{t('tickets.levelN', { n: l })}</option>)}
                </select>
              </Field>
              <Field label={t('tickets.group')}>
                <select className={selectCls} value={ticket.groupId ?? ''} disabled={locked} onChange={(e) => update.mutate({ groupId: e.target.value || null })}>
                  <option value="">—</option>
                  {meta?.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </Field>
              <Field label={t('tickets.assignee')}>
                <select className={selectCls} value={ticket.assigneeId ?? ''} disabled={locked} onChange={(e) => update.mutate({ assigneeId: e.target.value || null })}>
                  <option value="">{t('tickets.unassigned')}</option>
                  {assignees.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </Field>
              <Field label={t('tickets.category')}>
                <select className={selectCls} value={ticket.categoryId ?? ''} disabled={locked} onChange={(e) => update.mutate({ categoryId: e.target.value || null, subcategoryId: null })}>
                  <option value="">—</option>
                  {tree.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label={t('tickets.subcategory')}>
                <select className={selectCls} value={ticket.subcategoryId ?? ''} disabled={locked || subs.length === 0} onChange={(e) => update.mutate({ subcategoryId: e.target.value || null })}>
                  <option value="">—</option>
                  {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <Field label={t('tickets.dueAt')}>
                <input
                  type="datetime-local"
                  className={selectCls}
                  disabled={locked}
                  value={ticket.dueAt ? toLocalInput(ticket.dueAt) : ''}
                  onChange={(e) => update.mutate({ dueAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
                />
              </Field>
            </div>
          </Card>

          <Card><KbQuickSearch initial={ticket.subject} /></Card>

          <Card>
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-gray-900"><User className="h-4 w-4 text-gray-400" /> {t('tickets.contact')}</h2>
            {ticket.contact ? (
              <Link to={`/contacts/${ticket.contact.id}`} className="text-sm text-blue-600 hover:underline">
                {ticket.contact.name || formatPhone(ticket.contact.phone) || ticket.contact.email}
              </Link>
            ) : (
              <p className="text-sm text-gray-400">—</p>
            )}
          </Card>

          <Card>
            <h2 className="mb-2 text-sm font-semibold text-gray-900">{t('tickets.interactions')}</h2>
            {ticket.calls.length + ticket.conversations.length === 0 && <p className="text-sm text-gray-400">{t('tickets.noInteractions')}</p>}
            <ul className="divide-y divide-gray-100">
              {ticket.calls.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <Link to={`/calls/${c.id}`} className="flex min-w-0 items-center gap-1.5 text-gray-700 hover:text-blue-600">
                    <Phone className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                    <span className="truncate">{formatPhone(c.kind === 'INBOUND' ? c.fromNumber : c.toNumber)} · {formatDate(c.startedAt ?? c.createdAt)} · {formatDuration(c.durationSecs)}</span>
                  </Link>
                  {!locked && (
                    <Button size="sm" variant="ghost" title={t('tickets.unlink')} icon={<Unlink className="h-3.5 w-3.5" />} onClick={() => unlink.mutate({ callId: c.id })} />
                  )}
                </li>
              ))}
              {ticket.conversations.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <Link to="/inbox" className="flex min-w-0 items-center gap-1.5 text-gray-700 hover:text-blue-600">
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                    <span className="truncate">{c.inbox.name} · {formatDate(c.lastMessageAt)}</span>
                  </Link>
                  {!locked && (
                    <Button size="sm" variant="ghost" title={t('tickets.unlink')} icon={<Unlink className="h-3.5 w-3.5" />} onClick={() => unlink.mutate({ conversationId: c.id })} />
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={t('tickets.edit')}
        size="lg"
        footer={<>
          <Button variant="ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
          <Button
            loading={update.isPending}
            disabled={!editing?.subject.trim()}
            onClick={() => editing && update.mutate({ subject: editing.subject.trim(), description: editing.description.trim() || null })}
          >
            {t('common.save')}
          </Button>
        </>}
      >
        {editing && (
          <div className="space-y-4">
            <Input label={t('tickets.subject')} value={editing.subject} maxLength={200} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} />
            <Textarea label={t('tickets.description')} rows={6} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
          </div>
        )}
      </Modal>
    </>
  );
}

/** ISO → valor do <input type="datetime-local"> na hora local. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

type T = (key: string, opts?: Record<string, unknown>) => string;

/** Texto de um evento da linha do tempo; os ids passam a nomes pela meta. */
function describeEvent(e: TicketDetail['events'][number], meta: TicketMeta | undefined, t: T): string {
  const user = (v: string | null) => (v ? meta?.users.find((u) => u.id === v)?.name ?? '?' : t('tickets.unassigned'));
  const group = (v: string | null) => (v ? meta?.groups.find((g) => g.id === v)?.name ?? '?' : '—');
  const cat = (v: string | null) => {
    if (!v || v === '/') return '—';
    return v.split('/').filter(Boolean).map((cid) => meta?.categories.find((c) => c.id === cid)?.name ?? '?').join(' › ');
  };
  const link = (v: string | null) => (v?.startsWith('call:') ? t('tickets.aCall') : t('tickets.aConversation'));
  switch (e.type) {
    case 'CREATED': return t('tickets.ev.created');
    case 'STATUS': return t('tickets.ev.status', { from: t(`tickets.status.${e.fromValue}`), to: t(`tickets.status.${e.toValue}`) });
    case 'PRIORITY': return t('tickets.ev.priority', { from: t(`tickets.priority.${e.fromValue}`), to: t(`tickets.priority.${e.toValue}`) });
    case 'LEVEL': return t('tickets.ev.level', { from: e.fromValue, to: e.toValue });
    case 'ASSIGNEE': return t('tickets.ev.assignee', { to: user(e.toValue) });
    case 'GROUP': return t('tickets.ev.group', { to: group(e.toValue) });
    case 'CATEGORY': return t('tickets.ev.category', { to: cat(e.toValue) });
    case 'SUBJECT': return t('tickets.ev.subject', { to: e.toValue });
    case 'LINKED': return t('tickets.ev.linked', { what: link(e.toValue) });
    case 'UNLINKED': return t('tickets.ev.unlinked', { what: link(e.fromValue) });
    default: return e.type;
  }
}
