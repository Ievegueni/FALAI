import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Ticket as TicketIcon, Plus } from 'lucide-react';
import { ticketsApi } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import type { TicketMeta, TicketPriority, TicketRef, TicketStatus } from '@/types';

export const TICKET_STATUSES: TicketStatus[] = ['OPEN', 'PENDING', 'ON_HOLD', 'RESOLVED', 'CLOSED'];
export const TICKET_PRIORITIES: TicketPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export const selectCls = 'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700';

const statusColor: Record<TicketStatus, string> = {
  OPEN: 'bg-blue-100 text-blue-700',
  PENDING: 'bg-amber-100 text-amber-700',
  ON_HOLD: 'bg-purple-100 text-purple-700',
  RESOLVED: 'bg-emerald-100 text-emerald-700',
  CLOSED: 'bg-gray-100 text-gray-600',
};
const priorityColor: Record<TicketPriority, string> = {
  LOW: 'bg-gray-100 text-gray-600',
  MEDIUM: 'bg-sky-100 text-sky-700',
  HIGH: 'bg-orange-100 text-orange-700',
  URGENT: 'bg-red-100 text-red-700',
};

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  const { t } = useTranslation();
  return <Badge className={statusColor[status]}>{t(`tickets.status.${status}`)}</Badge>;
}

export function TicketPriorityBadge({ priority }: { priority: TicketPriority }) {
  const { t } = useTranslation();
  return <Badge className={priorityColor[priority]}>{t(`tickets.priority.${priority}`)}</Badge>;
}

export function useTicketsEnabled(): boolean {
  return useAuth().tenant?.features?.tickets === true;
}

export function useTicketMeta(enabled = true) {
  return useQuery({ queryKey: ['tickets', 'meta'], queryFn: ticketsApi.meta, staleTime: 60_000, enabled });
}

/** Categoria → subcategorias, a partir da lista plana. */
export function categoryTree(meta: TicketMeta | undefined) {
  const cats = meta?.categories ?? [];
  return cats.filter((c) => !c.parentId).map((c) => ({ ...c, subs: cats.filter((s) => s.parentId === c.id) }));
}

/**
 * Criar ticket. Vindo de uma chamada ou conversa, liga-a logo ao ticket e o
 * contacto vem dela (a API preenche).
 */
export function CreateTicketModal({
  open,
  onClose,
  contactId,
  callId,
  conversationId,
  defaultSubject = '',
}: {
  open: boolean;
  onClose: () => void;
  contactId?: string | null;
  callId?: string;
  conversationId?: string;
  defaultSubject?: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { success, error } = useToast();
  const { data: meta } = useTicketMeta(open);
  const tree = categoryTree(meta);
  // Agente: o ticket fica com ele por omissão; só pode deixá-lo na fila.
  const { user } = useAuth();
  const isAgent = user?.role === 'MEMBER';
  const assignees = isAgent ? (meta?.users ?? []).filter((u) => u.id === user?.id) : meta?.users ?? [];
  const empty = { subject: defaultSubject, description: '', priority: 'MEDIUM' as TicketPriority, supportLevel: 1, assigneeId: isAgent ? user!.id : '', groupId: '', categoryId: '', subcategoryId: '' };
  const [form, setForm] = useState(empty);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: () =>
      ticketsApi.create({
        subject: form.subject.trim(),
        description: form.description.trim() || null,
        priority: form.priority,
        supportLevel: form.supportLevel,
        assigneeId: form.assigneeId || null,
        groupId: form.groupId || null,
        categoryId: form.categoryId || null,
        subcategoryId: form.subcategoryId || null,
        ...(contactId && { contactId }),
        ...(callId && { callId }),
        ...(conversationId && { conversationId }),
      }),
    onSuccess: (ticket) => {
      success(t('tickets.created', { number: ticket.number }));
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      if (callId) void qc.invalidateQueries({ queryKey: ['calls', callId] });
      if (conversationId) void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      if (contactId) void qc.invalidateQueries({ queryKey: ['contact-profile', contactId] });
      setForm(empty);
      onClose();
      navigate(`/tickets/${ticket.id}`);
    },
    onError: (e: Error) => error(e.message),
  });

  const subs = tree.find((c) => c.id === form.categoryId)?.subs ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('tickets.new')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button loading={create.isPending} disabled={!form.subject.trim()} onClick={() => create.mutate()}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Input label={t('tickets.subject')} value={form.subject} onChange={(e) => set('subject', e.target.value)} maxLength={200} required autoFocus />
        </div>
        <div className="sm:col-span-2">
          <Textarea label={t('tickets.description')} value={form.description} onChange={(e) => set('description', e.target.value)} rows={4} />
        </div>
        <Field label={t('tickets.priorityLabel')}>
          <select className={selectCls} value={form.priority} onChange={(e) => set('priority', e.target.value as TicketPriority)}>
            {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{t(`tickets.priority.${p}`)}</option>)}
          </select>
        </Field>
        <Field label={t('tickets.level')}>
          <select className={selectCls} value={form.supportLevel} onChange={(e) => set('supportLevel', Number(e.target.value))}>
            {[1, 2, 3].map((l) => <option key={l} value={l}>{t('tickets.levelN', { n: l })}</option>)}
          </select>
        </Field>
        <Field label={t('tickets.group')}>
          <select className={selectCls} value={form.groupId} onChange={(e) => set('groupId', e.target.value)}>
            <option value="">—</option>
            {meta?.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
        <Field label={t('tickets.assignee')}>
          <select className={selectCls} value={form.assigneeId} onChange={(e) => set('assigneeId', e.target.value)}>
            <option value="">{t('tickets.unassigned')}</option>
            {assignees.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        <Field label={t('tickets.category')}>
          <select className={selectCls} value={form.categoryId} onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value, subcategoryId: '' }))}>
            <option value="">—</option>
            {tree.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label={t('tickets.subcategory')}>
          <select className={selectCls} value={form.subcategoryId} onChange={(e) => set('subcategoryId', e.target.value)} disabled={subs.length === 0}>
            <option value="">—</option>
            {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
      {label}
      {children}
    </label>
  );
}

/**
 * Numa chamada ou conversa: mostra o ticket a que pertence, ou o botão para
 * criar um. Não aparece se o cliente não tiver tickets activos.
 */
export function TicketLinkOrCreate({
  ticket,
  contactId,
  callId,
  conversationId,
  defaultSubject,
}: {
  ticket: TicketRef | null | undefined;
  contactId?: string | null;
  callId?: string;
  conversationId?: string;
  defaultSubject?: string;
}) {
  const { t } = useTranslation();
  const enabled = useTicketsEnabled();
  const [open, setOpen] = useState(false);
  if (!enabled) return null;
  if (ticket) {
    return (
      <Link to={`/tickets/${ticket.id}`} className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline">
        <TicketIcon className="h-3.5 w-3.5" />#{ticket.number} · {ticket.subject}
        <TicketStatusBadge status={ticket.status} />
      </Link>
    );
  }
  return (
    <>
      <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>
        {t('tickets.createFrom')}
      </Button>
      <CreateTicketModal
        open={open}
        onClose={() => setOpen(false)}
        {...(contactId !== undefined && { contactId })}
        {...(callId && { callId })}
        {...(conversationId && { conversationId })}
        {...(defaultSubject && { defaultSubject })}
      />
    </>
  );
}

/** Lista curta de tickets (perfil do cliente, screen pop). */
export function TicketRefList({ tickets }: { tickets: (TicketRef & { updatedAt?: string; supportLevel?: number })[] }) {
  const { t } = useTranslation();
  if (tickets.length === 0) return <p className="text-sm text-gray-400">{t('tickets.none')}</p>;
  return (
    <ul className="divide-y divide-gray-100">
      {tickets.map((tk) => (
        <li key={tk.id} className="flex items-center justify-between gap-3 py-2">
          <Link to={`/tickets/${tk.id}`} className="min-w-0 truncate text-sm text-gray-800 hover:text-blue-600 hover:underline">
            <span className="text-gray-400">#{tk.number}</span> {tk.subject}
          </Link>
          <span className="flex shrink-0 items-center gap-1.5">
            {tk.priority && <TicketPriorityBadge priority={tk.priority} />}
            <TicketStatusBadge status={tk.status} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Separador "Tickets" do perfil do cliente. */
export function ContactTicketsCard({ contactId, tickets }: { contactId: string; tickets: (TicketRef & { updatedAt?: string })[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">{t('tickets.title')}</h2>
        <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>{t('tickets.new')}</Button>
      </div>
      <TicketRefList tickets={tickets} />
      <CreateTicketModal open={open} onClose={() => setOpen(false)} contactId={contactId} />
    </div>
  );
}
