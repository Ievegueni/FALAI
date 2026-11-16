import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ClipboardList, Plus, Trash2 } from 'lucide-react';
import { contactFormsApi, telephonyApi, PROVINCES, type ContactField, type ContactFieldType, type ContactForm } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import { clsx } from '@/lib/utils';

/**
 * Fichas de recolha de dados: abrem sozinhas no painel da chamada e o que o
 * agente preenche fica no perfil do cliente (Contact.attributes, pela chave do
 * campo). As regras (obrigatórios, condições, NIF/BI) validam-se na API.
 */

const TYPES: ContactFieldType[] = ['text', 'number', 'date', 'email', 'select', 'yesno', 'nif', 'bi', 'province'];
const field = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';
const filled = (v: unknown) => v !== undefined && v !== null && v !== '';
/** Espelha isVisible da API: sem condição, ou o campo-pai tem o valor pedido. */
const visible = (f: ContactField, values: Record<string, unknown>) => !f.showIf || values[f.showIf.key] === f.showIf.equals;

/** Ficha no painel da chamada: a do grupo da chamada (ou a primeira), já aberta. */
export function ContactFormFill({ contactId, attributes, legId, groupId, onSaved }: {
  contactId: string;
  attributes: Record<string, unknown> | null;
  legId?: string | null;
  groupId?: string | null;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { success, error } = useToast();
  const { data: forms } = useQuery({ queryKey: ['contact-forms'], queryFn: () => contactFormsApi.list(), staleTime: 60_000 });
  const [open, setOpen] = useState(true);
  const [formId, setFormId] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const form = forms?.find((f) => f.id === formId);

  const start = (f: ContactForm) => {
    setFormId(f.id);
    setValues(Object.fromEntries(f.fields.map((x) => [x.key!, attributes?.[x.key!] ?? (x.type === 'yesno' ? null : '')])));
  };
  // Abre a ficha do grupo da chamada; sem grupo (ou sem ficha para ele), a primeira.
  useEffect(() => {
    if (!forms?.length || formId) return;
    start(forms.find((f) => groupId && f.groupIds.includes(groupId)) ?? forms[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forms, groupId]);

  const save = useMutation({
    mutationFn: () => contactFormsApi.fill(contactId, { formId: form!.id, values, ...(legId && { legId }) }),
    onSuccess: () => { success(t('common.saved')); onSaved(); },
    onError: (e: Error) => error(e.message),
  });

  if (!forms?.length || !form) return null;
  const base = form.fields.filter((f) => !f.showIf);
  const done = base.filter((f) => filled(values[f.key!])).length;
  const set = (k: string, v: unknown) => setValues((x) => ({ ...x, [k]: v }));

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/40">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        {open ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
        <ClipboardList className="h-4 w-4 text-blue-600" />
        <span className="flex-1 truncate text-sm font-medium text-gray-900">{form.name}</span>
        <span className="text-xs tabular-nums text-gray-500">{t('contactForms.progress', { done, total: base.length })}</span>
      </button>
      <div className="mx-3 mb-2 h-1.5 overflow-hidden rounded-full bg-gray-200" role="progressbar" aria-valuenow={done} aria-valuemax={base.length}>
        <div className="h-full bg-blue-600 transition-all" style={{ width: `${base.length ? (done / base.length) * 100 : 0}%` }} />
      </div>
      {open && (
        <form className="space-y-3 px-3 pb-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          {forms.length > 1 && (
            <select className={field} value={form.id} onChange={(e) => start(forms.find((f) => f.id === e.target.value)!)}>
              {forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          )}
          {form.fields.filter((f) => visible(f, values)).map((f) => {
            const k = f.key!;
            const v = values[k];
            const label = <span className="mb-1 block text-xs font-medium text-gray-700">{f.label}{f.required && <span className="text-red-500"> *</span>}</span>;
            if (f.type === 'yesno') {
              return (
                <div key={k}>
                  {label}
                  <div className="inline-flex rounded-lg border border-gray-300 bg-white p-0.5">
                    {([true, false] as const).map((b) => (
                      <button key={String(b)} type="button" onClick={() => set(k, v === b ? null : b)}
                        className={clsx('rounded-md px-3 py-1 text-sm', v === b ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100')}>
                        {t(b ? 'common.yes' : 'common.no')}
                      </button>
                    ))}
                  </div>
                </div>
              );
            }
            if (f.type === 'select' || f.type === 'province') {
              return (
                <label key={k} className="block">
                  {label}
                  <select className={field} value={String(v ?? '')} onChange={(e) => set(k, e.target.value)}>
                    <option value="">—</option>
                    {(f.type === 'province' ? PROVINCES : f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </label>
              );
            }
            return (
              <label key={k} className="block">
                {label}
                <input
                  className={field}
                  type={f.type === 'date' || f.type === 'email' ? f.type : 'text'}
                  inputMode={f.type === 'number' ? 'decimal' : undefined}
                  placeholder={f.type === 'bi' ? '004567890LA042' : f.type === 'nif' ? t('contactForms.nifHint') : undefined}
                  value={String(v ?? '')}
                  onChange={(e) => set(k, f.type === 'nif' || f.type === 'bi' ? e.target.value.toUpperCase() : e.target.value)}
                />
              </label>
            );
          })}
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={save.isPending}>{t('contactForms.save')}</Button>
          </div>
        </form>
      )}
    </div>
  );
}

const blankField = (): ContactField => ({ label: '', type: 'text', required: false });

function FormEditor({ form, onClose }: { form: ContactForm | 'new'; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const { data: groups } = useQuery({ queryKey: ['telephony', 'groups'], queryFn: telephonyApi.listGroups, retry: false });
  const [name, setName] = useState(form === 'new' ? '' : form.name);
  const [groupIds, setGroupIds] = useState<string[]>(form === 'new' ? [] : form.groupIds);
  const [fields, setFields] = useState<ContactField[]>(form === 'new' ? [blankField()] : structuredClone(form.fields));
  // Opções da lista editadas como texto ("a, b, c") e convertidas ao gravar.
  const [optText, setOptText] = useState<string[]>(fields.map((f) => f.options?.join(', ') ?? ''));
  const upd = (i: number, patch: Partial<ContactField>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const save = useMutation({
    mutationFn: () => {
      const out = fields.map((f, i) => ({
        ...f,
        ...(f.type === 'select' ? { options: optText[i]!.split(',').map((o) => o.trim()).filter(Boolean) } : { options: undefined }),
      }));
      const data = { name, fields: out, groupIds };
      return form === 'new' ? contactFormsApi.create(data) : contactFormsApi.update(form.id, data);
    },
    onSuccess: () => { success(t('common.saved')); void qc.invalidateQueries({ queryKey: ['contact-forms'] }); onClose(); },
    onError: (e: Error) => error(e.message),
  });

  /** Campos anteriores que podem servir de condição (sim/não ou lista já gravados com chave). */
  const parents = (i: number) => fields.slice(0, i).filter((p) => p.key && (p.type === 'yesno' || p.type === 'select'));
  const condValue = (f: ContactField) => (f.showIf ? `${f.showIf.key}=${String(f.showIf.equals)}` : '');
  const setCond = (i: number, raw: string) => {
    if (!raw) return upd(i, { showIf: undefined });
    const [key, eq] = [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)];
    const parent = fields.find((p) => p.key === key);
    upd(i, { showIf: { key, equals: parent?.type === 'yesno' ? eq === 'true' : eq } });
  };

  return (
    <Modal open onClose={onClose} size="xl" title={form === 'new' ? t('contactForms.new') : t('contactForms.edit')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>{t('common.save')}</Button></>}>
      <div className="space-y-4">
        <Input label={t('contactForms.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        {!!groups?.length && (
          <div>
            <p className="mb-1 text-sm font-medium text-gray-700">{t('contactForms.groups')}</p>
            <div className="flex flex-wrap gap-3">
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-1.5 text-sm text-gray-700">
                  <input type="checkbox" checked={groupIds.includes(g.id)} onChange={(e) => setGroupIds((ids) => (e.target.checked ? [...ids, g.id] : ids.filter((x) => x !== g.id)))} />
                  {g.name}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-gray-400">{t('contactForms.groupsHint')}</p>
          </div>
        )}
        <p className="text-xs text-gray-500">{t('contactForms.keyHint')}</p>
        {fields.map((f, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 p-3">
            <div className="min-w-[12rem] flex-1"><Input placeholder={t('contactForms.label')} value={f.label} onChange={(e) => upd(i, { label: e.target.value })} /></div>
            <select className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm" value={f.type} onChange={(e) => upd(i, { type: e.target.value as ContactFieldType })}>
              {TYPES.map((ty) => <option key={ty} value={ty}>{t(`contactForms.type.${ty}`)}</option>)}
            </select>
            <label className="flex items-center gap-1 text-xs text-gray-600">
              <input type="checkbox" checked={f.required} onChange={(e) => upd(i, { required: e.target.checked })} />{t('contactForms.required')}
            </label>
            {f.key && <span className="text-xs text-gray-400">{f.key}</span>}
            {fields.length > 1 && (
              <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
                onClick={() => { setFields((fs) => fs.filter((_, j) => j !== i)); setOptText((o) => o.filter((_, j) => j !== i)); }} />
            )}
            {f.type === 'select' && (
              <div className="w-full"><Input placeholder={t('contactForms.options')} value={optText[i] ?? ''} onChange={(e) => setOptText((o) => o.map((x, j) => (j === i ? e.target.value : x)))} /></div>
            )}
            {parents(i).length > 0 && (
              <label className="flex w-full items-center gap-2 text-xs text-gray-600">
                {t('contactForms.showIf')}
                <select className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs" value={condValue(f)} onChange={(e) => setCond(i, e.target.value)}>
                  <option value="">{t('contactForms.always')}</option>
                  {parents(i).flatMap((p) =>
                    (p.type === 'yesno' ? [['true', t('common.yes')], ['false', t('common.no')]] : (p.options ?? []).map((o) => [o, o])).map(([v, l]) => (
                      <option key={`${p.key}=${v}`} value={`${p.key}=${v}`}>{p.label} = {l}</option>
                    )),
                  )}
                </select>
              </label>
            )}
          </div>
        ))}
        <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => { setFields((fs) => [...fs, blankField()]); setOptText((o) => [...o, '']); }}>
          {t('contactForms.addField')}
        </Button>
        <p className="text-xs text-gray-400">{t('contactForms.showIfHint')}</p>
      </div>
    </Modal>
  );
}

/** Gestão das fichas (admin/gestor), no separador da Supervisão. */
export function ContactFormsAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { error } = useToast();
  const [editing, setEditing] = useState<ContactForm | 'new' | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['contact-forms', 'all'], queryFn: () => contactFormsApi.list(true) });
  const toggle = useMutation({
    mutationFn: (f: ContactForm) => contactFormsApi.update(f.id, { name: f.name, fields: f.fields, isActive: !f.isActive }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['contact-forms'] }),
    onError: (e: Error) => error(e.message),
  });
  if (isLoading) return <PageSpinner />;
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">{t('contactForms.intro')}</p>
      <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>{t('contactForms.new')}</Button>
      <Card padding={false}>
        <div className="divide-y divide-gray-50">
          {data?.map((f) => (
            <div key={f.id} className="flex items-center gap-4 px-5 py-3">
              <div className="flex-1">
                <p className={clsx('text-sm font-medium', f.isActive ? 'text-gray-900' : 'text-gray-400 line-through')}>{f.name}</p>
                <p className="text-xs text-gray-400">{f.fields.map((x) => x.label).join(' · ')}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setEditing(f)}>{t('common.edit')}</Button>
              <Button size="sm" variant="ghost" onClick={() => toggle.mutate(f)}>{f.isActive ? t('telephony.deactivate') : t('telephony.activate')}</Button>
            </div>
          ))}
          {data?.length === 0 && <p className="px-5 py-8 text-center text-sm text-gray-400">{t('contactForms.none')}</p>}
        </div>
      </Card>
      {editing && <FormEditor form={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
