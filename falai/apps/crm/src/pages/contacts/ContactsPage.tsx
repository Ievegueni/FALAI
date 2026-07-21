import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Upload, Users, Search, Phone, PhoneCall, Trash2, Download } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { contactsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageSpinner } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/contexts/ToastContext';
import { formatPhone, formatDate } from '@/lib/utils';
import type { Contact } from '@/types';

function CreateContactModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [errors, setErrors] = useState<typeof form>({ name: '', phone: '', email: '' });

  const create = useMutation({
    mutationFn: () => contactsApi.create({ name: form.name, phone: form.phone, email: form.email || undefined }),
    onSuccess: () => {
      success(t('contacts.created'));
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      onClose();
      setForm({ name: '', phone: '', email: '' });
    },
    onError: (e: Error) => error(e.message),
  });

  function handleSubmit() {
    const e = { name: '', phone: '', email: '' };
    if (!form.name.trim()) e.name = t('contacts.errNameRequired');
    if (!form.phone.trim()) e.phone = t('contacts.errPhoneRequired');
    setErrors(e);
    if (e.name || e.phone) return;
    create.mutate();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('contacts.modalNew')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button loading={create.isPending} onClick={handleSubmit}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label={t('contacts.modalName')}
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          error={errors.name}
          placeholder={t('contacts.modalNamePlaceholder')}
          required
          autoFocus
        />
        <Input
          label={t('contacts.modalPhone')}
          value={form.phone}
          onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          error={errors.phone}
          placeholder="+244 9XX XXX XXX"
          hint={t('contacts.modalPhoneHint')}
          required
        />
        <Input
          label={t('contacts.modalEmail')}
          type="email"
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          placeholder={t('contacts.modalEmailPlaceholder')}
        />
      </div>
    </Modal>
  );
}

function ContactRow({ contact }: { contact: Contact }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { success, error } = useToast();

  const del = useMutation({
    mutationFn: () => contactsApi.delete(contact.id),
    onSuccess: () => { success(t('contacts.deleted')); void qc.invalidateQueries({ queryKey: ['contacts'] }); },
    onError: (e: Error) => error(e.message),
  });

  return (
    <tr className="hover:bg-gray-50">
      <td className="px-4 py-3">
        <button
          onClick={() => navigate(`/contacts/${contact.id}`)}
          className="text-left"
        >
          <p className="text-sm font-medium text-gray-900 hover:text-blue-600 hover:underline">{contact.name}</p>
          {contact.email && <p className="text-xs text-gray-400">{contact.email}</p>}
        </button>
      </td>
      <td className="px-4 py-3 text-sm text-gray-600 flex items-center gap-1.5">
        <Phone className="h-3.5 w-3.5 text-gray-400" />
        {formatPhone(contact.phone)}
      </td>
      <td className="px-4 py-3">
        {contact.optedOutAt ? (
          <Badge className="bg-red-100 text-red-700">{t('contacts.optOut')}</Badge>
        ) : (
          <Badge className="bg-emerald-100 text-emerald-700">{t('contacts.active')}</Badge>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-gray-400">{formatDate(contact.createdAt)}</td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          {!contact.optedOutAt && (
            <Button
              size="sm"
              variant="ghost"
              icon={<PhoneCall className="h-3.5 w-3.5 text-green-600" />}
              title={t('contacts.callNow')}
              onClick={() => navigate('/calls/direct', { state: { to: contact.phone } })}
            />
          )}
          {!contact.optedOutAt && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
              loading={del.isPending}
              onClick={() => {
                if (confirm(t('contacts.deleteConfirm', { name: contact.name }))) del.mutate();
              }}
            />
          )}
        </div>
      </td>
    </tr>
  );
}

export function ContactsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  // Pré-preenche a pesquisa a partir do URL (ex.: screen pop de chamada a entrar → /contacts?search=+244…)
  const [search, setSearch] = useState(() => new URLSearchParams(window.location.search).get('search') ?? '');
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['contacts', page, search],
    queryFn: () => contactsApi.list({ page, search: search || undefined }),
  });

  return (
    <>
      <Header
        title={t('contacts.title')}
        actions={
          <>
            <Button size="sm" variant="outline" icon={<Upload className="h-3.5 w-3.5" />} onClick={() => navigate('/contacts/import')}>
              {t('contacts.import')}
            </Button>
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setShowCreate(true)}>
              {t('contacts.new')}
            </Button>
          </>
        }
      />

      <div className="p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex-1 max-w-sm">
            <Input
              placeholder={t('contacts.searchPlaceholder')}
              icon={<Search className="h-4 w-4" />}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          {data && (
            <p className="text-sm text-gray-500">{t('contacts.count', { count: data.total })}</p>
          )}
        </div>

        {isLoading ? (
          <PageSpinner />
        ) : data?.data.length === 0 ? (
          <EmptyState
            icon={<Users className="h-8 w-8" />}
            title={search ? t('contacts.emptySearchTitle') : t('contacts.emptyTitle')}
            description={search ? t('contacts.emptySearchDescription') : t('contacts.emptyDescription')}
            action={
              search
                ? undefined
                : { label: t('contacts.importList'), icon: <Upload className="h-4 w-4" />, onClick: () => navigate('/contacts/import') }
            }
          />
        ) : (
          <Card padding={false}>
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {[t('contacts.colName'), t('contacts.colPhone'), t('contacts.colStatus'), t('contacts.colCreated'), ''].map((h, i) => (
                    <th key={i} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data?.data.map((c) => <ContactRow key={c.id} contact={c} />)}
              </tbody>
            </table>
            {data && (
              <Pagination page={page} total={data.total} perPage={data.perPage} onPage={setPage} />
            )}
          </Card>
        )}
      </div>

      <CreateContactModal open={showCreate} onClose={() => setShowCreate(false)} />
    </>
  );
}
