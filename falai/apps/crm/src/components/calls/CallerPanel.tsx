import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { UserRound, EyeOff, UserPlus, Pencil, Plus, X, History, StickyNote, MessageSquare, Ban } from 'lucide-react';
import { callersApi, type CallerHistoryItem } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { clsx, formatDuration } from '@/lib/utils';
import { TicketLinkOrCreate, TicketRefList, useTicketsEnabled } from '@/components/tickets/TicketBits';
import { KbQuickSearch } from '@/components/knowledge/KbBits';
import { Ticket as TicketIcon } from 'lucide-react';

/**
 * Painel do cliente (screen pop, melhoria 3). Abre no toque — antes de
 * atender — com quem liga, o histórico e o que o CRM sabe dele. Quem o abre e
 * fecha é a página (o webphone): aqui só se mostra e edita.
 */

const e164 = (national: string) => `+244 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
const showPhone = (p: string | null) => (p && /^\d{9}$/.test(p) ? e164(p) : (p ?? '—'));

const STATE_CLASS: Record<string, string> = {
  ANSWERED: 'bg-emerald-50 text-emerald-700',
  COMPLETED: 'bg-emerald-50 text-emerald-700',
  MISSED: 'bg-amber-50 text-amber-700',
  NO_ANSWER: 'bg-amber-50 text-amber-700',
  REJECTED: 'bg-red-50 text-red-700',
  IN_PROGRESS: 'bg-blue-50 text-blue-700',
};

function HistoryRow({ h }: { h: CallerHistoryItem }) {
  const { t } = useTranslation();
  const inbound = h.kind === 'INBOUND';
  return (
    <div className="py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-gray-700">{new Date(h.at).toLocaleString()}</span>
        <Badge className={STATE_CLASS[h.state] ?? 'bg-gray-100 text-gray-600'}>
          {t(`callerPanel.state.${h.state}`, { defaultValue: h.state })}
        </Badge>
        {!inbound && <span className="text-xs text-gray-400">{t('callerPanel.outbound')}</span>}
        <span className="ml-auto text-xs text-gray-400 tabular-nums">{h.durationSecs > 0 ? formatDuration(h.durationSecs) : ''}</span>
      </div>
      <p className="text-xs text-gray-500">
        {[h.agent, h.group].filter(Boolean).join(' · ')}
        {h.typing && <span className="text-gray-700"> · {h.typing}</span>}
      </p>
      {h.note && <p className="text-xs italic text-gray-500">“{h.note}”</p>}
    </div>
  );
}

export function CallerPanel({ legId, number, onClose }: { legId?: string | null; number?: string | null; onClose?: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const key = ['caller-panel', legId ?? null, number ?? null];
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => callersApi.lookup(legId ? { legId } : { number: number ?? '' }),
    enabled: Boolean(legId || number !== undefined),
    staleTime: 30_000,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: key });

  const [more, setMore] = useState<CallerHistoryItem[]>([]);
  const [hasMore, setHasMore] = useState<boolean | null>(null);
  const [creating, setCreating] = useState<{ name: string; phone: string } | null>(null);
  const [editing, setEditing] = useState<{ name: string; email: string } | null>(null);
  const [newPhone, setNewPhone] = useState('');
  const [note, setNote] = useState('');

  const contact = data?.contact ?? null;
  const caller = data?.caller;
  const ticketsEnabled = useTicketsEnabled();

  const loadMore = useMutation({
    mutationFn: () => {
      const all = [...(data?.history?.data ?? []), ...more];
      return callersApi.history(contact!.id, all[all.length - 1]!.at);
    },
    onSuccess: (r) => { setMore((m) => [...m, ...r.data]); setHasMore(r.hasMore); },
    onError: (e: Error) => error(e.message),
  });
  const create = useMutation({
    mutationFn: () => callersApi.quickCreate({ name: creating!.name.trim(), phone: creating!.phone, ...(legId && { legId }) }),
    onSuccess: () => { success(t('callerPanel.created')); setCreating(null); refresh(); },
    onError: (e: Error) => error(e.message),
  });
  const update = useMutation({
    mutationFn: () => callersApi.update(contact!.id, { name: editing!.name.trim(), email: editing!.email.trim() || null }),
    onSuccess: () => { success(t('common.saved')); setEditing(null); refresh(); },
    onError: (e: Error) => error(e.message),
  });
  const addPhone = useMutation({
    mutationFn: () => callersApi.addPhone(contact!.id, { phone: newPhone }),
    onSuccess: () => { setNewPhone(''); refresh(); },
    onError: (e: Error) => error(e.message),
  });
  const removePhone = useMutation({
    mutationFn: (phoneId: string) => callersApi.removePhone(contact!.id, phoneId),
    onSuccess: refresh,
    onError: (e: Error) => error(e.message),
  });
  const addNote = useMutation({
    mutationFn: () => callersApi.addNote(contact!.id, { body: note.trim(), ...(legId && { legId }) }),
    onSuccess: () => { setNote(''); refresh(); },
    onError: (e: Error) => error(e.message),
  });

  const header = (icon: React.ReactNode, title: string, sub?: string) => (
    <div className="flex items-start gap-3">
      <div className="rounded-full bg-blue-50 p-2.5 text-blue-600">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold text-gray-900">{title}</p>
        {sub && <p className="text-sm text-gray-500">{sub}</p>}
      </div>
      {onClose && (
        <button onClick={onClose} aria-label={t('common.close')} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );

  if (isLoading || !caller) {
    return <Card className="w-full lg:max-w-md"><p className="text-sm text-gray-400">{t('callerPanel.loading')}</p></Card>;
  }

  if (caller.kind === 'HIDDEN') {
    return <Card className="w-full lg:max-w-md">{header(<EyeOff className="h-5 w-5" />, t('callerPanel.hidden'))}</Card>;
  }

  // ── Não identificado: contacto rápido ──
  if (!contact) {
    return (
      <Card className="w-full lg:max-w-md space-y-4">
        {header(<UserRound className="h-5 w-5" />, t('callerPanel.unknown'), caller.display)}
        {caller.national &&
          (creating ? (
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (creating.name.trim()) create.mutate(); }}>
              <Input label={t('common.name')} value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} autoFocus maxLength={120} />
              <Input label={t('callerPanel.phone')} value={creating.phone} onChange={(e) => setCreating({ ...creating, phone: e.target.value })} />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(null)}>{t('common.cancel')}</Button>
                <Button type="submit" size="sm" loading={create.isPending} disabled={!creating.name.trim()}>{t('common.create')}</Button>
              </div>
            </form>
          ) : (
            <Button size="sm" icon={<UserPlus className="h-4 w-4" />} onClick={() => setCreating({ name: '', phone: caller.national! })}>
              {t('callerPanel.quickCreate')}
            </Button>
          ))}
      </Card>
    );
  }

  const history = [...(data?.history?.data ?? []), ...more];
  const showMore = hasMore ?? data?.history?.hasMore ?? false;

  return (
    <Card className="w-full lg:max-w-md space-y-4">
      {editing ? (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (editing.name.trim()) update.mutate(); }}>
          <Input label={t('common.name')} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus maxLength={120} />
          <Input label="Email" type="email" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" loading={update.isPending}>{t('common.save')}</Button>
          </div>
        </form>
      ) : (
        <div>
          {header(<UserRound className="h-5 w-5" />, contact.name ?? t('callerPanel.noName'), caller.display)}
          <div className="mt-2 flex items-center gap-3 text-xs">
            <button className="inline-flex items-center gap-1 text-gray-500 hover:text-gray-800" onClick={() => setEditing({ name: contact.name ?? '', email: contact.email ?? '' })}>
              <Pencil className="h-3 w-3" /> {t('common.edit')}
            </button>
            <Link to={`/contacts/${contact.id}`} className="text-blue-600 hover:underline">{t('callerPanel.openContact')}</Link>
            {contact.email && <span className="text-gray-500">{contact.email}</span>}
          </div>
        </div>
      )}

      {contact.optedOutAt && (
        <p className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <Ban className="h-3.5 w-3.5" /> {t('callerPanel.optedOut')}
        </p>
      )}

      {/* Destaques */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-gray-50 px-3 py-2">
          <p className="text-xs text-gray-500">{t('callerPanel.last7Days')}</p>
          <p className="text-lg font-semibold text-gray-900">{data?.highlights?.callsLast7Days ?? 0}</p>
        </div>
        <div className="rounded-lg bg-gray-50 px-3 py-2 min-w-0">
          <p className="text-xs text-gray-500">{t('callerPanel.lastTyping')}</p>
          <p className="truncate text-sm font-medium text-gray-900">{data?.highlights?.lastTyping?.label ?? '—'}</p>
        </div>
      </div>

      {/* Números */}
      <div>
        <p className="mb-1 text-xs font-medium text-gray-500">{t('callerPanel.phones')}</p>
        <div className="flex flex-wrap gap-1.5">
          <Badge className="bg-gray-100 text-gray-700">{showPhone(contact.phone)}</Badge>
          {contact.phones.map((p) => (
            <Badge key={p.id} className="bg-gray-100 text-gray-700">
              {showPhone(p.phone)}{p.label ? ` · ${p.label}` : ''}
              <button className="ml-1 text-gray-400 hover:text-red-600" aria-label={t('common.delete')} onClick={() => removePhone.mutate(p.id)}>
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newPhone.trim()) addPhone.mutate(); }}>
          <div className="flex-1"><Input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder={t('callerPanel.addPhone')} /></div>
          <Button type="submit" size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} disabled={!newPhone.trim()} loading={addPhone.isPending} />
        </form>
      </div>

      {/* Dados adicionais do CRM */}
      {contact.attributes && Object.keys(contact.attributes).length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-gray-500">{t('callerPanel.attributes')}</p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {Object.entries(contact.attributes)
              .filter(([, v]) => v !== null && v !== '' && typeof v !== 'object')
              .slice(0, 8)
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="truncate text-gray-500">{k}</dt>
                  <dd className="truncate text-gray-800">{String(v)}</dd>
                </div>
              ))}
          </dl>
        </div>
      )}

      {/* Histórico */}
      <div>
        <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500"><History className="h-3.5 w-3.5" /> {t('callerPanel.history')}</p>
        {history.length === 0 ? (
          <p className="text-sm text-gray-400">{t('callerPanel.noHistory')}</p>
        ) : (
          <div className="divide-y divide-gray-50">{history.map((h) => <HistoryRow key={h.id} h={h} />)}</div>
        )}
        {showMore && (
          <Button size="sm" variant="ghost" loading={loadMore.isPending} onClick={() => loadMore.mutate()}>{t('callerPanel.seeMore')}</Button>
        )}
      </div>

      {/* Base de conhecimento (fase 10) */}
      <KbQuickSearch />

      {/* Tickets em aberto do cliente + criar a partir desta chamada */}
      {ticketsEnabled && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-xs font-medium text-gray-500"><TicketIcon className="h-3.5 w-3.5" /> {t('tickets.openTickets')}</p>
            <TicketLinkOrCreate ticket={null} contactId={contact.id} {...(data?.callId && { callId: data.callId })} />
          </div>
          <TicketRefList tickets={data?.openTickets ?? []} />
        </div>
      )}

      {/* Conversas dos canais de texto */}
      {(data?.conversations?.length ?? 0) > 0 && (
        <div>
          <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500"><MessageSquare className="h-3.5 w-3.5" /> {t('callerPanel.conversations')}</p>
          {data!.conversations!.map((c) => (
            <Link key={c.id} to="/inbox" className="block py-1 text-sm text-gray-700 hover:text-blue-600">
              {c.inbox.name} · <span className="text-xs text-gray-400">{c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : ''}</span>
            </Link>
          ))}
        </div>
      )}

      {/* Notas */}
      <div>
        <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500"><StickyNote className="h-3.5 w-3.5" /> {t('callerPanel.notes')}</p>
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) addNote.mutate(); }}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={4000} placeholder={t('callerPanel.notePlaceholder')} />
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!note.trim()} loading={addNote.isPending}>{t('callerPanel.addNote')}</Button>
          </div>
        </form>
        {(data?.notes ?? []).map((n) => (
          <div key={n.id} className={clsx('mt-2 rounded-lg bg-yellow-50 px-3 py-2 text-sm text-gray-800')}>
            <p className="whitespace-pre-wrap">{n.body}</p>
            <p className="mt-1 text-xs text-gray-400">{[n.author, new Date(n.createdAt).toLocaleString()].filter(Boolean).join(' · ')}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}
