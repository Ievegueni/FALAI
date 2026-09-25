import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, ListTree, PhoneIncoming, Volume2 } from 'lucide-react';
import { telephonyApi } from '@/lib/api';
import { toTelephonyWav } from '@/lib/telephonyWav';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import type { InboundRoute, IvrDestType, IvrMenu, IvrOption } from '@/types';

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'];

/** Extensões, grupos e menus do tenant — o que pode ser destino de uma chamada. */
function useDestinations() {
  const exts = useQuery({ queryKey: ['telephony', 'extensions'], queryFn: telephonyApi.listExtensions });
  const groups = useQuery({ queryKey: ['telephony', 'groups'], queryFn: telephonyApi.listGroups });
  const ivr = useQuery({ queryKey: ['telephony', 'ivr'], queryFn: telephonyApi.listIvr });
  const options: Record<IvrDestType, { value: string; label: string }[]> = {
    EXTENSION: (exts.data ?? []).map((e) => ({ value: e.number, label: `${e.number}${e.displayName ? ` — ${e.displayName}` : ''}` })),
    GROUP: (groups.data ?? []).map((g) => ({ value: g.id, label: g.name })),
    IVR: (ivr.data ?? []).map((m) => ({ value: m.id, label: m.name })),
  };
  const label = (type: string, value: string) =>
    options[type as IvrDestType]?.find((o) => o.value === value)?.label ?? value;
  return { options, label };
}

function DestPicker({ type, value, onChange, exclude }: {
  type: IvrDestType; value: string; onChange: (type: IvrDestType, value: string) => void; exclude?: string;
}) {
  const { t } = useTranslation();
  const { options } = useDestinations();
  const list = options[type].filter((o) => o.value !== exclude);
  return (
    <div className="grid grid-cols-2 gap-2">
      <Select value={type} onChange={(e) => onChange(e.target.value as IvrDestType, '')}>
        <option value="EXTENSION">{t('telephony.destExtension')}</option>
        <option value="GROUP">{t('telephony.destGroup')}</option>
        <option value="IVR">{t('telephony.destIvr')}</option>
      </Select>
      <Select value={value} onChange={(e) => onChange(type, e.target.value)}>
        <option value="">—</option>
        {list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </div>
  );
}

// ─── IVR ──────────────────────────────────────────────────────────────────────
const EMPTY_MENU: Omit<IvrMenu, 'id'> = { name: '', greeting: '', options: [], timeoutSecs: 6, maxRetries: 2 };

function IvrModal({ editing, onClose }: { editing: IvrMenu | 'new'; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [form, setForm] = useState<Omit<IvrMenu, 'id'>>(editing === 'new' ? EMPTY_MENU : editing);
  const [audio, setAudio] = useState<File | null>(null);
  const [removeAudio, setRemoveAudio] = useState(false);
  const keepsAudio = editing !== 'new' && !!editing.greetingAudio && !removeAudio;

  const setOption = (i: number, patch: Partial<IvrOption>) =>
    setForm((f) => ({ ...f, options: f.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  const nextDigit = DIGITS.find((d) => !form.options.some((o) => o.digit === d));

  const save = useMutation({
    mutationFn: async () => {
      if (!audio && !keepsAudio && form.greeting.trim().length < 2) throw new Error(t('telephony.ivrNeedGreeting'));
      // Converte antes de gravar: um ficheiro ilegível não deixa um menu a meio.
      const wav = audio ? await toTelephonyWav(audio) : null;
      const id = editing === 'new' ? (await telephonyApi.createIvr(form)).id : (await telephonyApi.updateIvr(editing.id, form), editing.id);
      if (wav) await telephonyApi.uploadIvrAudio(id, wav);
      else if (removeAudio) await telephonyApi.removeIvrAudio(id);
    },
    onSuccess: () => { success(t('common.saved')); onClose(); },
    onError: (e: Error) => error(e.message),
    // Uma falha do TTS grava o menu na mesma — a lista tem de o mostrar.
    onSettled: () => void qc.invalidateQueries({ queryKey: ['telephony', 'ivr'] }),
  });

  return (
    <Modal open onClose={onClose} title={editing === 'new' ? t('telephony.newIvr') : t('telephony.editIvr')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button></>}>
      <div className="space-y-4">
        <Input label={t('telephony.ivrName')} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Principal" required autoFocus />
        <Textarea label={t('telephony.ivrGreeting')} rows={3} value={form.greeting} hint={t('telephony.ivrGreetingHint')}
          onChange={(e) => setForm((f) => ({ ...f, greeting: e.target.value }))}
          placeholder="Bem-vindo. Para vendas, prima 1. Para suporte, prima 2." />
        <div>
          <p className="text-sm font-medium text-gray-700 mb-1.5">{t('telephony.ivrAudio')}</p>
          {keepsAudio && !audio ? (
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Volume2 className="h-4 w-4 text-green-600" /> {t('telephony.ivrAudioLoaded')}
              <Button size="sm" variant="ghost" onClick={() => setRemoveAudio(true)}>{t('telephony.ivrAudioRemove')}</Button>
            </div>
          ) : (
            <input type="file" accept="audio/*" onChange={(e) => setAudio(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-gray-200" />
          )}
          <p className="mt-1 text-xs text-gray-500">{t('telephony.ivrAudioHint')}</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input label={t('telephony.ivrTimeout')} type="number" min={2} max={30} value={form.timeoutSecs}
            onChange={(e) => setForm((f) => ({ ...f, timeoutSecs: Number(e.target.value) }))} />
          <Input label={t('telephony.ivrRetries')} type="number" min={0} max={5} value={form.maxRetries}
            onChange={(e) => setForm((f) => ({ ...f, maxRetries: Number(e.target.value) }))} />
        </div>
        <div>
          <p className="text-sm font-medium text-gray-700 mb-2">{t('telephony.ivrOptions')}</p>
          <div className="space-y-2">
            {form.options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select className="w-16" value={o.digit} onChange={(e) => setOption(i, { digit: e.target.value })}>
                  {DIGITS.map((d) => <option key={d} value={d}>{d}</option>)}
                </Select>
                <div className="flex-1">
                  <DestPicker type={o.destType} value={o.destValue} exclude={editing === 'new' ? undefined : editing.id}
                    onChange={(destType, destValue) => setOption(i, { destType, destValue })} />
                </div>
                <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
                  onClick={() => setForm((f) => ({ ...f, options: f.options.filter((_, j) => j !== i) }))} />
              </div>
            ))}
          </div>
          {nextDigit && (
            <Button size="sm" variant="ghost" className="mt-2" icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => setForm((f) => ({ ...f, options: [...f.options, { digit: nextDigit, destType: 'EXTENSION', destValue: '' }] }))}>
              {t('telephony.ivrAddOption')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function IvrTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [editing, setEditing] = useState<IvrMenu | 'new' | null>(null);
  const { label } = useDestinations();
  const { data: menus, isLoading } = useQuery({ queryKey: ['telephony', 'ivr'], queryFn: telephonyApi.listIvr });

  const remove = useMutation({
    mutationFn: (id: string) => telephonyApi.deleteIvr(id),
    onSuccess: () => { success(t('telephony.ivrDeleted')); void qc.invalidateQueries({ queryKey: ['telephony', 'ivr'] }); },
    onError: (e: Error) => error(e.message),
  });

  if (isLoading) return <PageSpinner />;

  return (
    <>
      <div className="flex justify-end mb-3">
        {canManage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>{t('telephony.newIvr')}</Button>}
      </div>
      <Card padding={false}>
        <div className="divide-y divide-gray-50">
          {menus?.map((m) => (
            <div key={m.id} className="flex items-start gap-4 px-5 py-3">
              <ListTree className="h-4 w-4 text-gray-400 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">{m.name}</p>
                <p className="text-xs text-gray-500 truncate">
                  {m.greetingAudio ? <><Volume2 className="inline h-3 w-3 mr-1" />{t('telephony.ivrAudioLoaded')}</> : `“${m.greeting}”`}
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  {m.options.map((o) => `${o.digit} → ${label(o.destType, o.destValue)}`).join(' · ') || t('telephony.ivrNoOptions')}
                </p>
              </div>
              {canManage && (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(m)}>{t('common.edit')}</Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
                    onClick={() => { if (confirm(t('telephony.ivrDeleteConfirm', { name: m.name }))) remove.mutate(m.id); }} />
                </div>
              )}
            </div>
          ))}
          {menus?.length === 0 && <div className="px-5 py-8 text-center text-gray-400 text-sm">{t('telephony.noIvr')}</div>}
        </div>
      </Card>
      {editing && <IvrModal editing={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

// ─── Rotas de entrada ─────────────────────────────────────────────────────────
function InboundRouteModal({ editing, onClose }: { editing: InboundRoute | 'new'; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const { data: trunks } = useQuery({ queryKey: ['telephony', 'trunks'], queryFn: telephonyApi.listTrunks });
  const [form, setForm] = useState(
    editing === 'new'
      ? { name: '', trunkId: '', didPattern: '', destType: 'IVR' as IvrDestType, destValue: '' }
      : { name: editing.name, trunkId: editing.trunkId, didPattern: editing.didPattern, destType: editing.destType as IvrDestType, destValue: editing.destValue },
  );
  const trunkId = form.trunkId || trunks?.trunks[0]?.id || '';

  const save = useMutation({
    mutationFn: (): Promise<unknown> => {
      const data = { ...form, trunkId };
      return editing === 'new' ? telephonyApi.createInboundRoute(data) : telephonyApi.updateInboundRoute(editing.id, data);
    },
    onSuccess: () => { success(t('common.saved')); void qc.invalidateQueries({ queryKey: ['telephony', 'inbound'] }); onClose(); },
    onError: (e: Error) => error(e.message),
  });

  return (
    <Modal open onClose={onClose} title={editing === 'new' ? t('telephony.newInbound') : t('telephony.editInbound')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Input label={t('telephony.inboundName')} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required autoFocus />
          <Input label="DID" value={form.didPattern} hint={t('telephony.inboundDidHint')}
            onChange={(e) => setForm((f) => ({ ...f, didPattern: e.target.value }))} placeholder="244222000000" required />
        </div>
        <Select label={t('telephony.tabTrunk')} value={trunkId} onChange={(e) => setForm((f) => ({ ...f, trunkId: e.target.value }))}>
          {trunks?.trunks.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
        </Select>
        <div>
          <p className="text-sm font-medium text-gray-700 mb-1.5">{t('telephony.destination')}</p>
          <DestPicker type={form.destType} value={form.destValue} onChange={(destType, destValue) => setForm((f) => ({ ...f, destType, destValue }))} />
        </div>
      </div>
    </Modal>
  );
}

export function InboundRoutesTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [editing, setEditing] = useState<InboundRoute | 'new' | null>(null);
  const { label } = useDestinations();
  const { data: routes, isLoading } = useQuery({ queryKey: ['telephony', 'inbound'], queryFn: telephonyApi.listInboundRoutes });

  const remove = useMutation({
    mutationFn: (id: string) => telephonyApi.deleteInboundRoute(id),
    onSuccess: () => { success(t('telephony.inboundDeleted')); void qc.invalidateQueries({ queryKey: ['telephony', 'inbound'] }); },
    onError: (e: Error) => error(e.message),
  });

  if (isLoading) return <PageSpinner />;

  const typeLabel: Record<string, string> = {
    EXTENSION: t('telephony.destExtension'), GROUP: t('telephony.destGroup'), IVR: t('telephony.destIvr'), AI_AGENT: 'IA',
  };

  return (
    <>
      <div className="flex justify-end mb-3">
        {canManage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>{t('telephony.newInbound')}</Button>}
      </div>
      <Card padding={false}>
        <div className="divide-y divide-gray-50">
          {routes?.map((r) => (
            <div key={r.id} className="flex items-center gap-4 px-5 py-3">
              <PhoneIncoming className="h-4 w-4 text-gray-400" />
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">{r.name} <span className="font-mono text-xs text-gray-500">{r.didPattern}</span></p>
                <p className="text-xs text-gray-400">{r.trunkName} → {typeLabel[r.destType]}: {label(r.destType, r.destValue)}</p>
              </div>
              {canManage && (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>{t('common.edit')}</Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
                    onClick={() => { if (confirm(t('telephony.inboundDeleteConfirm', { name: r.name }))) remove.mutate(r.id); }} />
                </div>
              )}
            </div>
          ))}
          {routes?.length === 0 && <div className="px-5 py-8 text-center text-gray-400 text-sm">{t('telephony.noInbound')}</div>}
        </div>
      </Card>
      {editing && <InboundRouteModal editing={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
