import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Phone, PhoneCall, User, Stethoscope, Save, Pencil, PhoneIncoming, PhoneOutgoing,
  FileSpreadsheet, Plus, X, Merge, Tag, Headphones, StickyNote,
} from 'lucide-react';
import { contactsApi, type ContactHistoryFilters, type ContactProfile } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Tabs } from '@/components/ui/Tabs';
import { Pagination } from '@/components/ui/Pagination';
import { PageSpinner } from '@/components/ui/Spinner';
import { DonutCard } from '@/components/reports/charts';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { ContactTicketsCard, useTicketsEnabled } from '@/components/tickets/TicketBits';
import { formatDate, formatDuration, formatPhone } from '@/lib/utils';

/**
 * Perfil completo do cliente (melhoria 5). O painel da chamada (melhoria 3) é
 * a versão resumida; aqui: cabeçalho com todos os números, resumo calculado
 * no servidor, histórico filtrável, tipificações, notas, edição e união de
 * duplicados. A ficha clínica continua para quem tem essa licença.
 */

// Contrato dos campos clínicos guardados em Contact.attributes (ver melhorias.md §5)
// A chave é estável; a etiqueta é traduzida via contacts.clinic.<key>
const CLINIC_FIELDS: { key: string; type: 'text' | 'date' | 'textarea' }[] = [
  { key: 'nrProcesso', type: 'text' },
  { key: 'dataNascimento', type: 'date' },
  { key: 'ultimaConsulta', type: 'date' },
  { key: 'proximaConsulta', type: 'date' },
  { key: 'medicoResponsavel', type: 'text' },
  { key: 'alergias', type: 'text' },
  { key: 'notas', type: 'textarea' },
];

const STATE_CLASS: Record<string, string> = {
  ANSWERED: 'bg-emerald-100 text-emerald-700',
  MISSED: 'bg-amber-100 text-amber-700',
  REJECTED: 'bg-red-100 text-red-700',
  IN_PROGRESS: 'bg-blue-100 text-blue-700',
};
const MERGE_ROLES = new Set(['OWNER', 'ADMIN', 'SUPERVISOR']);
const selectCls = 'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700';

function saveBlob({ blob, filename }: { blob: Blob; filename: string }) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone ?? 'text-gray-900'}`}>{value}</p>
    </div>
  );
}

function Fact({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string | null }) {
  return (
    <div className="flex gap-3 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500">{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-gray-500">{label}</p>
        <p className="truncate text-sm font-medium text-gray-900" title={value}>{value}</p>
        {sub && <p className="truncate text-xs text-gray-400" title={sub}>{sub}</p>}
      </div>
    </div>
  );
}

// ─── Histórico ───────────────────────────────────────────────────────────────

function HistoryTab({ id, profile }: { id: string; profile: ContactProfile }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { error } = useToast();
  const [f, setF] = useState<ContactHistoryFilters>({ page: 1, pageSize: 20 });
  const set = (patch: Partial<ContactHistoryFilters>) => setF((x) => ({ ...x, ...patch, page: patch.page ?? 1 }));
  const [exporting, setExporting] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['contact-history', id, f],
    queryFn: () => contactsApi.history(id, f),
    placeholderData: keepPreviousData,
  });

  const exportXlsx = async () => {
    setExporting(true);
    try {
      saveBlob(await contactsApi.exportHistory(id, f));
    } catch (e) {
      error(e instanceof Error ? e.message : t('common.saveError'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card padding={false}>
      <div className="flex flex-wrap items-end gap-2 border-b border-gray-200 px-4 py-3">
        <label className="text-xs text-gray-500">
          {t('profile.from')}
          <input type="date" className={`${selectCls} mt-1 block`} value={f.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} />
        </label>
        <label className="text-xs text-gray-500">
          {t('profile.to')}
          <input type="date" className={`${selectCls} mt-1 block`} value={f.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} />
        </label>
        <select className={selectCls} value={f.state ?? ''} onChange={(e) => set({ state: (e.target.value || undefined) as ContactHistoryFilters['state'] })}>
          <option value="">{t('profile.allStates')}</option>
          {(['ANSWERED', 'MISSED', 'REJECTED'] as const).map((s) => <option key={s} value={s}>{t(`profile.state.${s}`)}</option>)}
        </select>
        <select className={selectCls} value={f.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value || undefined })}>
          <option value="">{t('profile.allTypings')}</option>
          {profile.filters.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className={selectCls} value={f.extensionId ?? ''} onChange={(e) => set({ extensionId: e.target.value || undefined })}>
          <option value="">{t('profile.allAgents')}</option>
          {profile.filters.agents.map((a) => <option key={a.extensionId} value={a.extensionId}>{a.name}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-3">
          {data && <span className="whitespace-nowrap text-sm text-gray-500">{t('profile.callsCount', { count: data.total })}</span>}
          <Button size="sm" variant="outline" icon={<FileSpreadsheet className="h-3.5 w-3.5" />} loading={exporting} onClick={() => void exportXlsx()}>
            {t('profile.exportExcel')}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <PageSpinner />
      ) : !data || data.data.length === 0 ? (
        <div className="py-10 text-center text-sm text-gray-500">{t('contacts.noCalls')}</div>
      ) : (
        <div>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                {['date', 'direction', 'agent', 'group', 'duration', 'state', 'typing', 'note'].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">{t(`profile.col.${h}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.data.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-gray-50" onClick={() => navigate(`/calls/${c.id}`)}>
                  <td className="px-4 py-2.5 text-gray-600">{formatDate(c.at)}</td>
                  <td className="px-4 py-2.5">
                    {c.direction === 'INBOUND' ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700"><PhoneIncoming className="h-3.5 w-3.5" />{t('profile.inbound')}</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-blue-700"><PhoneOutgoing className="h-3.5 w-3.5" />{t('profile.outbound')}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-gray-700">{c.agent ?? '—'}</td>
                  <td className="px-4 py-2.5 text-gray-500">{c.group ?? '—'}</td>
                  <td className="px-4 py-2.5 text-gray-500">{c.durationSecs != null ? formatDuration(c.durationSecs) : '—'}</td>
                  <td className="px-4 py-2.5"><Badge className={STATE_CLASS[c.state]}>{t(`profile.state.${c.state}`)}</Badge></td>
                  <td className="px-4 py-2.5 text-gray-700">{c.typing ?? '—'}</td>
                  <td className="max-w-xs truncate px-4 py-2.5 text-gray-500" title={c.note ?? ''}>{c.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={data.page} total={data.total} perPage={data.pageSize} onPage={(page) => set({ page })} />
        </div>
      )}
    </Card>
  );
}

// ─── Tipificações ────────────────────────────────────────────────────────────

function TypingsTab({ profile }: { profile: ContactProfile }) {
  const { t } = useTranslation();
  const { distribution, timeline, total } = profile.typings;
  if (total === 0) return <Card><p className="py-8 text-center text-sm text-gray-500">{t('profile.noTypings')}</p></Card>;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <DonutCard title={t('profile.byCategory')} slices={distribution.map((d) => ({ label: d.name, value: d.count }))} emptyText="" />
      <Card padding={false}>
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">{t('profile.col.typing')}</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">{t('profile.count')}</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">%</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {distribution.flatMap((d) => [
              <tr key={d.id} className="font-medium text-gray-900">
                <td className="px-4 py-2">{d.name}</td>
                <td className="px-4 py-2 text-right">{d.count}</td>
                <td className="px-4 py-2 text-right">{d.pct.toLocaleString('pt-PT')}%</td>
              </tr>,
              ...d.subs.map((s) => (
                <tr key={`${d.id}-${s.id}`} className="text-gray-600">
                  <td className="py-1.5 pl-8 pr-4">{s.name}</td>
                  <td className="px-4 py-1.5 text-right">{s.count}</td>
                  <td className="px-4 py-1.5 text-right text-gray-400">{s.pct.toLocaleString('pt-PT')}%</td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
        <p className="border-t border-gray-100 px-4 py-2 text-xs text-gray-400">{t('profile.subPctHint')}</p>
      </Card>
      <Card className="lg:col-span-2">
        <h2 className="mb-4 text-sm font-semibold text-gray-900">{t('profile.timeline')}</h2>
        <ol className="relative max-h-[28rem] overflow-y-auto border-l border-gray-200 pl-5">
          {[...timeline].reverse().map((e, i) => (
            <li key={`${e.callId}-${i}`} className="relative pb-4">
              <span className="absolute -left-[1.6rem] top-1.5 h-2.5 w-2.5 rounded-full bg-blue-600 ring-4 ring-white" />
              <p className="text-xs text-gray-400">{formatDate(e.at)} · {e.agent}</p>
              <Link to={`/calls/${e.callId}`} className="text-sm font-medium text-gray-900 hover:text-blue-600">{e.label}</Link>
              {e.note && <p className="text-sm text-gray-600">{e.note}</p>}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

// ─── Notas ───────────────────────────────────────────────────────────────────

function NotesTab({ profile }: { profile: ContactProfile }) {
  const { t } = useTranslation();
  if (profile.notes.length === 0) return <Card><p className="py-8 text-center text-sm text-gray-500">{t('profile.noNotes')}</p></Card>;
  return (
    <Card padding={false}>
      <ul className="divide-y divide-gray-100">
        {profile.notes.map((n) => (
          <li key={`${n.source}-${n.id}`} className="px-5 py-3">
            <p className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
              <span>{formatDate(n.at)}</span>
              <span>·</span>
              <span className="text-gray-600">{n.author ?? '—'}</span>
              <Badge className={n.source === 'TYPING' ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600'}>
                {n.source === 'TYPING' ? t('profile.noteTyping') : t('profile.noteFree')}
              </Badge>
              {n.callId && <Link to={`/calls/${n.callId}`} className="text-blue-600 hover:underline">{t('profile.seeCall')}</Link>}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-gray-800">{n.body}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ─── Números e união de duplicados ───────────────────────────────────────────

function PhonesModal({ open, onClose, profile }: { open: boolean; onClose: () => void; profile: ContactProfile }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { success, error } = useToast();
  const [phone, setPhone] = useState('');
  const [label, setLabel] = useState('');
  const id = profile.contact.id;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['contact-profile', id] });

  const add = useMutation({
    mutationFn: () => contactsApi.addPhone(id, phone, label.trim() || undefined),
    onSuccess: () => { success(t('profile.phoneAdded')); setPhone(''); setLabel(''); refresh(); },
    onError: (e: Error & { body?: { contactId?: string } }) => error(e.message),
  });
  const remove = useMutation({
    mutationFn: (phoneId: string) => contactsApi.removePhone(id, phoneId),
    onSuccess: refresh,
    onError: (e: Error) => error(e.message),
  });

  return (
    <Modal open={open} onClose={onClose} title={t('profile.phones')}>
      <div className="space-y-4">
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          <li className="flex items-center gap-3 px-3 py-2 text-sm">
            <Phone className="h-3.5 w-3.5 text-gray-400" />
            <span className="flex-1 text-gray-900">{formatPhone(profile.contact.phone)}</span>
            <Badge className="bg-blue-50 text-blue-700">{t('profile.mainPhone')}</Badge>
          </li>
          {profile.contact.phones.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Phone className="h-3.5 w-3.5 text-gray-400" />
              <span className="flex-1 text-gray-900">{formatPhone(p.phone)}{p.label && <span className="ml-2 text-xs text-gray-400">{p.label}</span>}</span>
              <button className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600" title={t('profile.removePhone')} onClick={() => remove.mutate(p.id)}>
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[10rem] flex-1"><Input label={t('profile.newPhone')} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="923 456 789" /></div>
          <div className="w-32"><Input label={t('profile.phoneLabel')} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('profile.phoneLabelPh')} /></div>
          <Button icon={<Plus className="h-3.5 w-3.5" />} loading={add.isPending} disabled={phone.replace(/\D/g, '').length < 9} onClick={() => add.mutate()}>
            {t('common.add')}
          </Button>
        </div>
        <p className="text-xs text-gray-500">{t('profile.phonesHint')}</p>
        {add.error && /outro contacto/.test(add.error.message) && (
          <p className="text-xs text-amber-700">
            {t('profile.phoneTakenMerge')}{' '}
            <button className="underline" onClick={() => { onClose(); navigate(`/contacts?search=${encodeURIComponent(phone)}`); }}>{t('profile.findOwner')}</button>
          </p>
        )}
      </div>
    </Modal>
  );
}

function MergeModal({ open, onClose, profile }: { open: boolean; onClose: () => void; profile: ContactProfile }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [q, setQ] = useState('');
  const [other, setOther] = useState<{ id: string; name: string; phone: string | null } | null>(null);
  const id = profile.contact.id;

  const { data: results, isFetching } = useQuery({
    queryKey: ['contacts', 'merge-search', q],
    queryFn: () => contactsApi.list({ page: 1, search: q }),
    enabled: open && q.trim().length >= 2,
  });

  const merge = useMutation({
    mutationFn: () => contactsApi.merge(id, other!.id),
    onSuccess: (r) => {
      success(t('profile.merged', { count: r.moved.calls ?? 0 }));
      void qc.invalidateQueries({ queryKey: ['contact-profile', id] });
      void qc.invalidateQueries({ queryKey: ['contact-history', id] });
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      setOther(null); setQ('');
      onClose();
    },
    onError: (e: Error) => error(e.message),
  });

  const keepName = profile.contact.name || formatPhone(profile.contact.phone);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('profile.mergeTitle')}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="danger" disabled={!other} loading={merge.isPending} onClick={() => merge.mutate()}>{t('profile.mergeConfirm')}</Button>
      </>}
    >
      <div className="space-y-3">
        <p className="text-sm text-gray-600">{t('profile.mergeIntro', { name: keepName })}</p>
        <Input placeholder={t('profile.mergeSearch')} value={q} onChange={(e) => { setQ(e.target.value); setOther(null); }} autoFocus />
        {q.trim().length >= 2 && (
          <ul className="max-h-56 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200">
            {isFetching && !results && <li className="px-3 py-2 text-sm text-gray-400">…</li>}
            {results?.data.filter((c) => c.id !== id).map((c) => (
              <li key={c.id}>
                <button
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-gray-50 ${other?.id === c.id ? 'bg-blue-50' : ''}`}
                  onClick={() => setOther({ id: c.id, name: c.name, phone: c.phone })}
                >
                  <input type="radio" readOnly checked={other?.id === c.id} />
                  <span className="flex-1 text-gray-900">{c.name || '—'}</span>
                  <span className="text-xs text-gray-500">{formatPhone(c.phone)}</span>
                </button>
              </li>
            ))}
            {results && results.data.filter((c) => c.id !== id).length === 0 && <li className="px-3 py-2 text-sm text-gray-400">{t('profile.mergeNone')}</li>}
          </ul>
        )}
        {other && (
          <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            {t('profile.mergeWarning', { other: other.name || formatPhone(other.phone), keep: keepName })}
          </p>
        )}
      </div>
    </Modal>
  );
}

// ─── Página ──────────────────────────────────────────────────────────────────

export function ContactDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { tenant, user } = useAuth();
  const { success, error } = useToast();
  const [tab, setTab] = useState('history');
  const [phonesOpen, setPhonesOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  const clinicEnabled = tenant?.plan?.clinicEnabled === true;
  const ticketsEnabled = useTicketsEnabled();
  const canEdit = user?.role !== 'VIEWER';
  const canMerge = !!user && MERGE_ROLES.has(user.role);

  const { data: profile, isLoading } = useQuery({
    queryKey: ['contact-profile', id],
    queryFn: () => contactsApi.profile(id!),
    retry: false,
  });
  const contact = profile?.contact;

  const [fields, setFields] = useState<Record<string, string>>({});
  useEffect(() => {
    if (contact) setFields({ ...(contact.attributes ?? {}) });
  }, [contact]);

  const save = useMutation({
    mutationFn: () => contactsApi.update(id!, { attributes: fields }),
    onSuccess: () => {
      success(t('contacts.sheetUpdated'));
      void qc.invalidateQueries({ queryKey: ['contact-profile', id] });
    },
    onError: (e: Error) => error(e.message),
  });

  // Edição dos dados base do contacto (nome + número principal)
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', phone: '' });
  const [editErrors, setEditErrors] = useState({ name: '', phone: '' });

  const openEdit = () => {
    if (!contact) return;
    const digits = (contact.phone ?? '').replace(/\D/g, '');
    const local = digits.startsWith('244') && digits.length === 12 ? digits.slice(3) : digits;
    setEditForm({ name: contact.name ?? '', phone: local });
    setEditErrors({ name: '', phone: '' });
    setEditOpen(true);
  };

  const updateContact = useMutation({
    mutationFn: () => contactsApi.update(id!, { name: editForm.name, phone: editForm.phone }),
    onSuccess: () => {
      success(t('contacts.contactUpdated'));
      setEditOpen(false);
      void qc.invalidateQueries({ queryKey: ['contact-profile', id] });
      void qc.invalidateQueries({ queryKey: ['contacts'] });
    },
    onError: (e: Error) => error(e.message),
  });

  const submitEdit = () => {
    const errs = { name: '', phone: '' };
    if (!editForm.name.trim()) errs.name = t('contacts.errNameRequired');
    if (!editForm.phone.trim()) errs.phone = t('contacts.errPhoneRequired');
    setEditErrors(errs);
    if (errs.name || errs.phone) return;
    updateContact.mutate();
  };

  if (isLoading) return <><Header title={t('contacts.contactTitle')} /><PageSpinner /></>;
  if (!profile || !contact) return <><Header title={t('contacts.contactTitle')} /><div className="p-6 text-sm text-gray-500">{t('contacts.notFound')}</div></>;

  const s = profile.summary;
  const tabs = [
    { key: 'history', label: t('profile.tabHistory'), badge: s.total },
    { key: 'typings', label: t('profile.tabTypings') },
    { key: 'notes', label: t('profile.tabNotes'), badge: profile.notes.length },
    ...(ticketsEnabled ? [{ key: 'tickets', label: t('tickets.title'), badge: profile.tickets.length }] : []),
    ...(clinicEnabled ? [{ key: 'clinic', label: t('contacts.clinicSheet') }] : []),
  ];

  return (
    <>
      <Header
        title={t('profile.title')}
        actions={
          <div className="flex items-center gap-2">
            {!contact.optedOutAt && contact.phone && (
              <Button size="sm" icon={<PhoneCall className="h-3.5 w-3.5" />} onClick={() => navigate('/calls/direct', { state: { to: contact.phone } })}>
                {t('contacts.call')}
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => navigate(-1)}>
              {t('common.back')}
            </Button>
          </div>
        }
      />

      <div className="max-w-6xl space-y-6 p-4 sm:p-6">
        {/* Cabeçalho */}
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gray-100">
                <User className="h-6 w-6 text-gray-500" />
              </div>
              <div className="min-w-0">
                <p className="text-lg font-semibold text-gray-900">{contact.name || t('profile.noName')}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {contact.phone && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-0.5 text-xs text-blue-700">
                      <Phone className="h-3 w-3" />{formatPhone(contact.phone)}
                    </span>
                  )}
                  {contact.phones.map((p) => (
                    <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-700" title={p.label ?? ''}>
                      <Phone className="h-3 w-3" />{formatPhone(p.phone)}{p.label && <span className="text-gray-400">· {p.label}</span>}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  {t('profile.firstContact')}: <span className="text-gray-700">{s.firstContactAt ? formatDate(s.firstContactAt) : '—'}</span>
                  {' · '}
                  {t('profile.lastContact')}: <span className="text-gray-700">{s.lastContactAt ? formatDate(s.lastContactAt) : '—'}</span>
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {contact.optedOutAt ? (
                <Badge className="bg-red-100 text-red-700">{t('contacts.optOut')}</Badge>
              ) : (
                <Badge className="bg-emerald-100 text-emerald-700">{t('contacts.active')}</Badge>
              )}
              {canEdit && (
                <>
                  <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={openEdit}>{t('contacts.edit')}</Button>
                  <Button size="sm" variant="ghost" icon={<Phone className="h-3.5 w-3.5" />} onClick={() => setPhonesOpen(true)}>{t('profile.phones')}</Button>
                </>
              )}
              {canMerge && (
                <Button size="sm" variant="ghost" icon={<Merge className="h-3.5 w-3.5" />} onClick={() => setMergeOpen(true)}>{t('profile.merge')}</Button>
              )}
            </div>
          </div>
        </Card>

        {/* Resumo (calculado no servidor) */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label={t('profile.total')} value={s.total} />
          <Stat label={t('profile.answered')} value={s.answered} tone="text-emerald-700" />
          <Stat label={t('profile.missed')} value={s.missed} tone="text-amber-700" />
          <Stat label={t('profile.rejected')} value={s.rejected} tone="text-red-600" />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <Fact icon={<Tag className="h-4 w-4" />} label={t('profile.topTyping')} value={s.topTyping?.label ?? '—'} sub={s.topTyping ? t('profile.times', { count: s.topTyping.count }) : null} />
          <Fact icon={<StickyNote className="h-4 w-4" />} label={t('profile.lastTyping')} value={s.lastTyping?.label ?? '—'} sub={s.lastTyping ? [formatDate(s.lastTyping.at), s.lastTyping.note].filter(Boolean).join(' · ') : null} />
          <Fact icon={<Headphones className="h-4 w-4" />} label={t('profile.topAgent')} value={s.topAgent?.name ?? '—'} sub={s.topAgent ? t('profile.answeredTimes', { count: s.topAgent.count }) : null} />
        </div>

        <Tabs tabs={tabs} active={tab} onChange={setTab} />

        {tab === 'history' && <HistoryTab id={contact.id} profile={profile} />}
        {tab === 'typings' && <TypingsTab profile={profile} />}
        {tab === 'notes' && <NotesTab profile={profile} />}
        {tab === 'tickets' && ticketsEnabled && <ContactTicketsCard contactId={contact.id} tickets={profile.tickets} />}
        {tab === 'clinic' && clinicEnabled && (
          <Card>
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-900">
              <Stethoscope className="h-4 w-4 text-teal-600" /> {t('contacts.clinicSheet')}
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {CLINIC_FIELDS.map((f) => (
                <div key={f.key} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}>
                  {f.type === 'textarea' ? (
                    <Textarea label={t(`contacts.clinic.${f.key}`)} rows={3} value={fields[f.key] ?? ''} onChange={(e) => setFields((x) => ({ ...x, [f.key]: e.target.value }))} />
                  ) : (
                    <Input label={t(`contacts.clinic.${f.key}`)} type={f.type} value={fields[f.key] ?? ''} onChange={(e) => setFields((x) => ({ ...x, [f.key]: e.target.value }))} />
                  )}
                </div>
              ))}
            </div>
            {canEdit && (
              <div className="mt-4 flex justify-end">
                <Button size="sm" icon={<Save className="h-3.5 w-3.5" />} loading={save.isPending} onClick={() => save.mutate()}>{t('contacts.saveSheet')}</Button>
              </div>
            )}
          </Card>
        )}
      </div>

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={t('contacts.editTitle')}
        footer={<>
          <Button variant="ghost" onClick={() => setEditOpen(false)}>{t('common.cancel')}</Button>
          <Button loading={updateContact.isPending} onClick={submitEdit}>{t('common.save')}</Button>
        </>}
      >
        <div className="space-y-4">
          <Input label={t('contacts.modalName')} value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} error={editErrors.name} placeholder={t('contacts.modalNamePlaceholder')} />
          <Input label={t('contacts.modalPhone')} value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} error={editErrors.phone} hint={t('contacts.modalPhoneHint')} />
        </div>
      </Modal>
      <PhonesModal open={phonesOpen} onClose={() => setPhonesOpen(false)} profile={profile} />
      <MergeModal open={mergeOpen} onClose={() => setMergeOpen(false)} profile={profile} />
    </>
  );
}
