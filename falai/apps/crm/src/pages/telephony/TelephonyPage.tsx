import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, KeyRound, Users, Shield, Copy, Check, Radio, Lock } from 'lucide-react';
import { telephonyApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Tabs } from '@/components/ui/Tabs';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import type { Extension, ExtensionGroup, TelephonyRole, TrunkView } from '@/types';

// ─── Mostrador de credenciais SIP (uma única vez) ────────────────────────────
function SipCredentialsModal({ ext, onClose }: { ext: Extension | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!ext?.sipAuthSecret) return null;

  const copy = () => {
    void navigator.clipboard.writeText(`user: ${ext.sipAuthUser}\nsecret: ${ext.sipAuthSecret}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Modal open onClose={onClose} title={t('telephony.sipCredsTitle', { number: ext.number })} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <div className="space-y-3">
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-700">
          {t('telephony.sipCredsWarn')}
        </div>
        <div className="rounded-lg bg-slate-900 text-slate-100 p-3 font-mono text-sm space-y-1">
          <div><span className="text-slate-400">user:</span> {ext.sipAuthUser}</div>
          <div><span className="text-slate-400">secret:</span> {ext.sipAuthSecret}</div>
        </div>
        <Button variant="ghost" size="sm" icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} onClick={copy}>
          {copied ? t('telephony.copied') : t('telephony.copy')}
        </Button>
      </div>
    </Modal>
  );
}

// ─── Modal criar/editar extensão (campos base) ────────────────────────────────
function ExtensionModal({ open, onClose, editing, roles, onReveal }: {
  open: boolean; onClose: () => void; editing: Extension | null; roles: TelephonyRole[]; onReveal: (e: Extension) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [form, setForm] = useState({ number: '', callerId: '', displayName: '', email: '', mobile: '', roleId: '' });

  // Sincroniza o formulário quando abre em modo edição
  const [lastId, setLastId] = useState<string | null>(null);
  if (open && editing && editing.id !== lastId) {
    setLastId(editing.id);
    setForm({
      number: editing.number,
      callerId: editing.callerId,
      displayName: editing.displayName ?? '',
      email: editing.email ?? '',
      mobile: editing.mobile ?? '',
      roleId: editing.roleId ?? '',
    });
  }
  if (open && !editing && lastId !== null) {
    setLastId(null);
    setForm({ number: '', callerId: '', displayName: '', email: '', mobile: '', roleId: '' });
  }

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        callerId: form.callerId || undefined,
        displayName: form.displayName || undefined,
        email: form.email || null,
        mobile: form.mobile || null,
        roleId: form.roleId || null,
      };
      if (editing) return telephonyApi.updateExtension(editing.id, payload);
      return telephonyApi.createExtension({ number: form.number, ...payload });
    },
    onSuccess: (ext) => {
      success(t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['telephony', 'extensions'] });
      onClose();
      if (!editing && ext.sipAuthSecret) onReveal(ext); // revela credenciais na criação
    },
    onError: (e: Error) => error(e.message),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t('telephony.editExtension', { number: editing.number }) : t('telephony.newExtension')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button></>}
    >
      <div className="grid grid-cols-2 gap-4">
        <Input label={t('telephony.number')} value={form.number} disabled={!!editing} onChange={(e) => setForm((f) => ({ ...f, number: e.target.value }))} placeholder="1000" required autoFocus={!editing} />
        <Input label={t('telephony.callerId')} value={form.callerId} onChange={(e) => setForm((f) => ({ ...f, callerId: e.target.value }))} placeholder={form.number} />
        <Input label={t('telephony.displayName')} value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} />
        <Select label={t('telephony.role')} value={form.roleId} onChange={(e) => setForm((f) => ({ ...f, roleId: e.target.value }))}>
          <option value="">{t('telephony.noRole')}</option>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </Select>
        <Input label={t('telephony.email')} type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
        <Input label={t('telephony.mobile')} value={form.mobile} onChange={(e) => setForm((f) => ({ ...f, mobile: e.target.value }))} />
      </div>
    </Modal>
  );
}

function ExtensionsTab({ canManage, roles }: { canManage: boolean; roles: TelephonyRole[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [modal, setModal] = useState<{ open: boolean; editing: Extension | null }>({ open: false, editing: null });
  const [reveal, setReveal] = useState<Extension | null>(null);

  const { data: exts, isLoading } = useQuery({ queryKey: ['telephony', 'extensions'], queryFn: telephonyApi.listExtensions });

  const remove = useMutation({
    mutationFn: (id: string) => telephonyApi.deleteExtension(id),
    onSuccess: () => { success(t('telephony.extDeleted')); void qc.invalidateQueries({ queryKey: ['telephony', 'extensions'] }); },
    onError: (e: Error) => error(e.message),
  });
  const resetSip = useMutation({
    mutationFn: (id: string) => telephonyApi.resetExtensionSip(id),
    onSuccess: (ext) => { success(t('telephony.sipReset')); void qc.invalidateQueries({ queryKey: ['telephony', 'extensions'] }); setReveal(ext); },
    onError: (e: Error) => error(e.message),
  });

  const roleName = (id: string | null) => roles.find((r) => r.id === id)?.name;

  if (isLoading) return <PageSpinner />;

  return (
    <>
      <div className="flex justify-end mb-3">
        {canManage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setModal({ open: true, editing: null })}>{t('telephony.newExtension')}</Button>}
      </div>
      <Card padding={false}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-gray-400 border-b border-gray-100">
            <tr>
              <th className="px-5 py-2.5 font-medium">{t('telephony.number')}</th>
              <th className="px-5 py-2.5 font-medium">{t('telephony.displayName')}</th>
              <th className="px-5 py-2.5 font-medium">{t('telephony.role')}</th>
              <th className="px-5 py-2.5 font-medium">{t('telephony.sipUser')}</th>
              <th className="px-5 py-2.5 font-medium">{t('common.status')}</th>
              <th className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {exts?.map((e) => (
              <tr key={e.id} className="hover:bg-gray-50">
                <td className="px-5 py-2.5 font-medium text-gray-900">
                  {e.number}{e.isDefault && <Badge className="ml-2 bg-blue-100 text-blue-700">{t('telephony.default')}</Badge>}
                </td>
                <td className="px-5 py-2.5 text-gray-600">{e.displayName ?? '—'}<div className="text-xs text-gray-400">{e.email}</div></td>
                <td className="px-5 py-2.5 text-gray-600">{roleName(e.roleId) ?? '—'}</td>
                <td className="px-5 py-2.5 font-mono text-xs text-gray-500">{e.sipAuthUser}</td>
                <td className="px-5 py-2.5">
                  <Badge className={e.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}>
                    {e.isActive ? t('telephony.active') : t('telephony.inactive')}
                  </Badge>
                </td>
                <td className="px-5 py-2.5 text-right whitespace-nowrap">
                  {canManage && (
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setModal({ open: true, editing: e })}>{t('common.edit')}</Button>
                      <Button size="sm" variant="ghost" icon={<KeyRound className="h-3.5 w-3.5 text-amber-600" />} loading={resetSip.isPending} title={t('telephony.resetSip')}
                        onClick={() => { if (confirm(t('telephony.resetSipConfirm', { number: e.number }))) resetSip.mutate(e.id); }} />
                      <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
                        onClick={() => { if (confirm(t('telephony.extDeleteConfirm', { number: e.number }))) remove.mutate(e.id); }} />
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {exts?.length === 0 && <tr><td colSpan={6} className="px-5 py-8 text-center text-gray-400">{t('telephony.noExtensions')}</td></tr>}
          </tbody>
        </table>
      </Card>

      <ExtensionModal open={modal.open} editing={modal.editing} roles={roles} onClose={() => setModal({ open: false, editing: null })} onReveal={setReveal} />
      <SipCredentialsModal ext={reveal} onClose={() => setReveal(null)} />
    </>
  );
}

function GroupModal({ open, onClose, editing, extensions }: {
  open: boolean; onClose: () => void; editing: ExtensionGroup | null; extensions: Extension[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [lastId, setLastId] = useState<string | null>(null);

  if (open && editing && editing.id !== lastId) {
    setLastId(editing.id);
    setName(editing.name);
    setMembers(editing.members.map((m) => m.id));
  }
  if (open && !editing && lastId !== null) { setLastId(null); setName(''); setMembers([]); }

  const toggle = (id: string) => setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));

  const save = useMutation({
    mutationFn: () => editing ? telephonyApi.updateGroup(editing.id, { name, memberIds: members }) : telephonyApi.createGroup({ name, memberIds: members }),
    onSuccess: () => { success(t('common.saved')); void qc.invalidateQueries({ queryKey: ['telephony', 'groups'] }); onClose(); },
    onError: (e: Error) => error(e.message),
  });

  return (
    <Modal open={open} onClose={onClose} title={editing ? t('telephony.editGroup') : t('telephony.newGroup')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button></>}>
      <div className="space-y-4">
        <Input label={t('telephony.groupName')} value={name} onChange={(e) => setName(e.target.value)} placeholder="VENDAS" required autoFocus />
        <div>
          <p className="text-sm font-medium text-gray-700 mb-2">{t('telephony.members')}</p>
          <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-50">
            {extensions.map((e) => (
              <label key={e.id} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer">
                <input type="checkbox" checked={members.includes(e.id)} onChange={() => toggle(e.id)} />
                <span className="font-medium text-gray-900">{e.number}</span>
                <span className="text-gray-400">{e.displayName}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function GroupsTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [modal, setModal] = useState<{ open: boolean; editing: ExtensionGroup | null }>({ open: false, editing: null });

  const { data: groups, isLoading } = useQuery({ queryKey: ['telephony', 'groups'], queryFn: telephonyApi.listGroups });
  const { data: exts } = useQuery({ queryKey: ['telephony', 'extensions'], queryFn: telephonyApi.listExtensions });

  const remove = useMutation({
    mutationFn: (id: string) => telephonyApi.deleteGroup(id),
    onSuccess: () => { success(t('telephony.groupDeleted')); void qc.invalidateQueries({ queryKey: ['telephony', 'groups'] }); },
    onError: (e: Error) => error(e.message),
  });

  if (isLoading) return <PageSpinner />;

  return (
    <>
      <div className="flex justify-end mb-3">
        {canManage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setModal({ open: true, editing: null })}>{t('telephony.newGroup')}</Button>}
      </div>
      <Card padding={false}>
        <div className="divide-y divide-gray-50">
          {groups?.map((g) => (
            <div key={g.id} className="flex items-center gap-4 px-5 py-3">
              <Users className="h-4 w-4 text-gray-400" />
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">{g.name}{g.isDefault && <Badge className="ml-2 bg-blue-100 text-blue-700">{t('telephony.default')}</Badge>}</p>
                <p className="text-xs text-gray-400">{t('telephony.memberCount', { count: g.total })}</p>
              </div>
              {canManage && (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setModal({ open: true, editing: g })}>{t('common.edit')}</Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
                    onClick={() => { if (confirm(t('telephony.groupDeleteConfirm', { name: g.name }))) remove.mutate(g.id); }} />
                </div>
              )}
            </div>
          ))}
          {groups?.length === 0 && <div className="px-5 py-8 text-center text-gray-400 text-sm">{t('telephony.noGroups')}</div>}
        </div>
      </Card>
      <GroupModal open={modal.open} editing={modal.editing} extensions={exts ?? []} onClose={() => setModal({ open: false, editing: null })} />
    </>
  );
}

function RolesTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [modal, setModal] = useState<{ open: boolean; editing: TelephonyRole | null }>({ open: false, editing: null });
  const [name, setName] = useState('');
  const [lastId, setLastId] = useState<string | null>(null);

  const { data: roles, isLoading } = useQuery({ queryKey: ['telephony', 'roles'], queryFn: telephonyApi.listRoles });

  if (modal.open && modal.editing && modal.editing.id !== lastId) { setLastId(modal.editing.id); setName(modal.editing.name); }
  if (modal.open && !modal.editing && lastId !== null) { setLastId(null); setName(''); }

  const save = useMutation({
    mutationFn: () => modal.editing ? telephonyApi.updateRole(modal.editing.id, { name }) : telephonyApi.createRole({ name }),
    onSuccess: () => { success(t('common.saved')); void qc.invalidateQueries({ queryKey: ['telephony', 'roles'] }); setModal({ open: false, editing: null }); },
    onError: (e: Error) => error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => telephonyApi.deleteRole(id),
    onSuccess: () => { success(t('telephony.roleDeleted')); void qc.invalidateQueries({ queryKey: ['telephony', 'roles'] }); },
    onError: (e: Error) => error(e.message),
  });

  if (isLoading) return <PageSpinner />;

  return (
    <>
      <div className="flex justify-end mb-3">
        {canManage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setModal({ open: true, editing: null })}>{t('telephony.newRole')}</Button>}
      </div>
      <Card padding={false}>
        <div className="divide-y divide-gray-50">
          {roles?.map((r) => (
            <div key={r.id} className="flex items-center gap-4 px-5 py-3">
              <Shield className="h-4 w-4 text-gray-400" />
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">{r.name}</p>
                <p className="text-xs text-gray-400">{t('telephony.extCount', { count: r._count?.extensions ?? 0 })}</p>
              </div>
              {canManage && (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setModal({ open: true, editing: r })}>{t('common.edit')}</Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
                    onClick={() => { if (confirm(t('telephony.roleDeleteConfirm', { name: r.name }))) remove.mutate(r.id); }} />
                </div>
              )}
            </div>
          ))}
          {roles?.length === 0 && <div className="px-5 py-8 text-center text-gray-400 text-sm">{t('telephony.noRoles')}</div>}
        </div>
      </Card>
      <Modal open={modal.open} onClose={() => setModal({ open: false, editing: null })} title={modal.editing ? t('telephony.editRole') : t('telephony.newRole')}
        footer={<><Button variant="ghost" onClick={() => setModal({ open: false, editing: null })}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button></>}>
        <Input label={t('telephony.roleName')} value={name} onChange={(e) => setName(e.target.value)} placeholder="Operator" required autoFocus />
      </Modal>
    </>
  );
}

function TrunkEditModal({ trunk, onClose }: { trunk: TrunkView; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [form, setForm] = useState({ host: trunk.host, port: String(trunk.port), authUser: trunk.authUser, authSecret: '' });

  const save = useMutation({
    mutationFn: () => telephonyApi.updateTrunk(trunk.id, {
      host: form.host, port: Number(form.port) || 5060, authUser: form.authUser,
      ...(form.authSecret ? { authSecret: form.authSecret } : {}),
    }),
    onSuccess: () => { success(t('common.saved')); void qc.invalidateQueries({ queryKey: ['telephony', 'trunks'] }); onClose(); },
    onError: (e: Error) => error(e.message),
  });

  return (
    <Modal open onClose={onClose} title={t('telephony.editTrunk', { name: trunk.name })}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button></>}>
      <div className="grid grid-cols-2 gap-4">
        <Input label={t('telephony.trunkHost')} value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} />
        <Input label={t('telephony.trunkPort')} value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} />
        <Input label={t('telephony.trunkUser')} value={form.authUser} onChange={(e) => setForm((f) => ({ ...f, authUser: e.target.value }))} />
        <Input label={t('telephony.trunkSecret')} type="password" value={form.authSecret} onChange={(e) => setForm((f) => ({ ...f, authSecret: e.target.value }))} hint={t('telephony.trunkSecretHint')} />
      </div>
    </Modal>
  );
}

function TrunkTab() {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<TrunkView | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['telephony', 'trunks'], queryFn: telephonyApi.listTrunks });
  if (isLoading) return <PageSpinner />;

  return (
    <div className="space-y-4">
      {data?.trunks.length === 0 && <div className="px-5 py-8 text-center text-gray-400 text-sm">{t('telephony.noTrunks')}</div>}
      {data?.trunks.map((tr) => (
        <Card key={tr.id}>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <Radio className="h-5 w-5 text-gray-400" />
              <div>
                <p className="text-sm font-semibold text-gray-900">{tr.name}</p>
                <p className="font-mono text-xs text-gray-500">{tr.transport} {tr.host}:{tr.port}</p>
              </div>
            </div>
            {tr.editable
              ? <Button size="sm" variant="ghost" onClick={() => setEditing(tr)}>{t('common.edit')}</Button>
              : <Badge className="bg-gray-100 text-gray-500"><Lock className="h-3 w-3 inline mr-1" />{t('telephony.managedByOperator')}</Badge>}
          </div>
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div><p className="text-gray-400">{t('telephony.trunkUser')}</p><p className="font-mono text-gray-700">{tr.authUser}</p></div>
            <div><p className="text-gray-400">{t('telephony.trunkType')}</p><p className="text-gray-700">{tr.type === 'REGISTER' ? t('telephony.trunkRegister') : 'Peer'}</p></div>
            <div><p className="text-gray-400">DTMF</p><p className="text-gray-700">{tr.dtmfMode}</p></div>
            <div><p className="text-gray-400">DIDs</p><p className="font-mono text-gray-700">{tr.dids.map((d) => d.did).join(', ') || '—'}</p></div>
            <div className="col-span-2 md:col-span-4"><p className="text-gray-400">Codecs</p><p className="text-gray-700">{tr.codecs.join(', ')}</p></div>
          </div>
        </Card>
      ))}
      {editing && <TrunkEditModal trunk={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

export function TelephonyPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [tab, setTab] = useState('extensions');
  const canManage = user?.role === 'OWNER' || user?.role === 'ADMIN';

  const { data: roles } = useQuery({ queryKey: ['telephony', 'roles'], queryFn: telephonyApi.listRoles });

  return (
    <>
      <Header title={t('telephony.title')} />
      <div className="p-6 max-w-4xl">
        <Tabs
          className="mb-5"
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'extensions', label: t('telephony.tabExtensions') },
            { key: 'groups', label: t('telephony.tabGroups') },
            { key: 'roles', label: t('telephony.tabRoles') },
            { key: 'trunk', label: t('telephony.tabTrunk') },
          ]}
        />
        {tab === 'extensions' && <ExtensionsTab canManage={canManage} roles={roles ?? []} />}
        {tab === 'groups' && <GroupsTab canManage={canManage} />}
        {tab === 'roles' && <RolesTab canManage={canManage} />}
        {tab === 'trunk' && <TrunkTab />}
      </div>
    </>
  );
}
