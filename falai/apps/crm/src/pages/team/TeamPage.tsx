import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation, Trans } from 'react-i18next';
import { Plus, UserCheck, Trash2, Shield, CalendarClock } from 'lucide-react';
import { teamApi, telephonyApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import { formatDate } from '@/lib/utils';
import { isConfigAdmin, isOpsManager } from '@/lib/roles';
import { ShiftsModal } from './ShiftsModal';
import type { TenantRole, TenantUser } from '@/types';

const ROLE_LABEL_KEYS: Record<TenantRole, string> = {
  OWNER: 'team.roleOwner',
  ADMIN: 'team.roleAdmin',
  MANAGER: 'team.roleManager',
  SUPERVISOR: 'team.roleSupervisor',
  MEMBER: 'team.roleMember',
  VIEWER: 'team.roleViewer',
};

const ROLE_COLORS: Record<TenantRole, string> = {
  OWNER: 'bg-purple-100 text-purple-700',
  ADMIN: 'bg-blue-100 text-blue-700',
  MANAGER: 'bg-indigo-100 text-indigo-700',
  SUPERVISOR: 'bg-amber-100 text-amber-700',
  MEMBER: 'bg-gray-100 text-gray-700',
  VIEWER: 'bg-slate-100 text-slate-600',
};

const ROLE_OPTIONS: TenantRole[] = ['ADMIN', 'MANAGER', 'SUPERVISOR', 'MEMBER', 'VIEWER'];
// O gestor (MANAGER) só gere estes — administradores e gestores só um administrador.
const MANAGER_ASSIGNABLE = new Set<TenantRole>(['SUPERVISOR', 'MEMBER', 'VIEWER']);
const ROLE_OPT_KEYS: Record<string, string> = {
  ADMIN: 'team.roleAdminOpt',
  MANAGER: 'team.roleManagerOpt',
  SUPERVISOR: 'team.roleSupervisorOpt',
  MEMBER: 'team.roleMemberOpt',
  VIEWER: 'team.roleViewerOpt',
};

function GroupChecks({ groups, value, onChange, disabled }: {
  groups: { id: string; name: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {groups.map((g) => (
        <label key={g.id} className={`flex items-center gap-2 text-sm text-gray-700 ${disabled ? 'opacity-50' : ''}`}>
          <input
            type="checkbox"
            disabled={disabled}
            checked={value.includes(g.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, g.id] : value.filter((x) => x !== g.id))}
          />
          {g.name}
        </label>
      ))}
    </div>
  );
}

/**
 * Criar ou editar um utilizador: o gestor define a password (não há convite),
 * o papel, a extensão, os grupos onde a extensão atende e — se for supervisor —
 * os grupos que supervisiona.
 */
function MemberModal({ open, member, onClose }: { open: boolean; member: TenantUser | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const isNew = member === null;
  const { user: me } = useAuth();
  const roleOptions = isConfigAdmin(me?.role) ? ROLE_OPTIONS : ROLE_OPTIONS.filter((r) => MANAGER_ASSIGNABLE.has(r));
  const blank = { name: '', email: '', password: '', role: 'MEMBER' as TenantRole, extensionId: '', groupIds: [] as string[], supervisedGroupIds: [] as string[] };
  const [form, setForm] = useState(blank);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const key = open ? (member?.id ?? 'new') : null;
  if (key !== loadedFor) {
    setLoadedFor(key);
    setForm(member ? {
      name: member.name,
      email: member.email,
      password: '',
      role: member.role,
      extensionId: member.extensionId ?? '',
      groupIds: member.groupIds ?? [],
      supervisedGroupIds: member.supervisedGroupIds ?? [],
    } : blank);
  }
  const set = <K extends keyof typeof blank>(k: K, v: (typeof blank)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const { data: extensions } = useQuery({ queryKey: ['telephony', 'extensions'], queryFn: telephonyApi.listExtensions, retry: false, enabled: open });
  const { data: groups } = useQuery({ queryKey: ['telephony', 'groups'], queryFn: telephonyApi.listGroups, retry: false, enabled: open });

  const save = useMutation({
    mutationFn: () => {
      const common = {
        extensionId: form.extensionId || null,
        ...(form.extensionId ? { groupIds: form.groupIds } : {}),
        ...(form.role === 'SUPERVISOR' ? { supervisedGroupIds: form.supervisedGroupIds } : {}),
      };
      if (isNew) return teamApi.create({ ...common, name: form.name, email: form.email, password: form.password, role: form.role });
      return teamApi.update(member.id, {
        ...common,
        name: form.name,
        ...(member.role !== 'OWNER' && { role: form.role }),
        ...(form.password && { password: form.password }),
      });
    },
    onSuccess: () => {
      success(isNew ? t('team.userCreated') : t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['team'] });
      void qc.invalidateQueries({ queryKey: ['telephony', 'groups'] });
      onClose();
    },
    onError: (e: Error) => error(e.message),
  });

  const passwordOk = isNew ? form.password.length >= 8 : form.password === '' || form.password.length >= 8;
  const canSave = form.name.trim().length >= 2 && (!isNew || form.email.includes('@')) && passwordOk;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isNew ? t('team.newUser') : (member?.name ?? '')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button loading={save.isPending} disabled={!canSave} onClick={() => save.mutate()}>
            {isNew ? t('team.createUser') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input label={t('team.name')} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={t('team.namePlaceholder')} required autoFocus />
        <Input
          label={t('team.email')}
          type="email"
          value={form.email}
          onChange={(e) => set('email', e.target.value)}
          placeholder={t('team.emailPlaceholder')}
          hint={isNew ? t('team.emailHint') : undefined}
          disabled={!isNew}
          required={isNew}
        />
        <Input
          label={isNew ? t('team.password') : t('team.newPassword')}
          type="text"
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => set('password', e.target.value)}
          hint={isNew ? t('team.passwordHint') : t('team.newPasswordHint')}
          error={form.password && form.password.length < 8 ? t('team.passwordShort') : undefined}
          required={isNew}
        />
        {member?.role !== 'OWNER' && member?.id !== me?.id && (
          <Select label={t('team.role')} value={form.role} onChange={(e) => set('role', e.target.value as TenantRole)}>
            {roleOptions.map((r) => <option key={r} value={r}>{t(ROLE_OPT_KEYS[r]!)}</option>)}
          </Select>
        )}
        <Select label={t('team.extension')} hint={t('team.extensionHint')} value={form.extensionId} onChange={(e) => set('extensionId', e.target.value)}>
          <option value="">—</option>
          {extensions?.map((x) => (
            <option key={x.id} value={x.id}>{x.number}{x.displayName && x.displayName !== x.number ? ` — ${x.displayName}` : ''}</option>
          ))}
        </Select>
        {(groups?.length ?? 0) > 0 && (
          <div>
            <p className="text-sm font-medium text-gray-700 mb-1">{t('team.groups')}</p>
            <GroupChecks groups={groups!} value={form.groupIds} onChange={(v) => set('groupIds', v)} disabled={!form.extensionId} />
            <p className="mt-1 text-xs text-gray-500">{form.extensionId ? t('team.groupsHint') : t('team.groupsNeedExtension')}</p>
          </div>
        )}
        {form.role === 'SUPERVISOR' && (groups?.length ?? 0) > 0 && (
          <div>
            <p className="text-sm font-medium text-gray-700 mb-1">{t('team.supervisedGroups')}</p>
            <GroupChecks groups={groups!} value={form.supervisedGroupIds} onChange={(v) => set('supervisedGroupIds', v)} />
          </div>
        )}
      </div>
    </Modal>
  );
}

export function TeamPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const { success, error } = useToast();
  // null = fechado; 'new' = criar; um membro = editar
  const [editing, setEditing] = useState<TenantUser | 'new' | null>(null);
  const [shiftsFor, setShiftsFor] = useState<TenantUser | null>(null);

  const { data: team, isLoading } = useQuery({
    queryKey: ['team'],
    queryFn: teamApi.list,
  });

  const remove = useMutation({
    mutationFn: (id: string) => teamApi.remove(id),
    onSuccess: () => { success(t('team.memberRemoved')); void qc.invalidateQueries({ queryKey: ['team'] }); },
    onError: (e: Error) => error(e.message),
  });

  const canManage = isOpsManager(user?.role);
  // Gestor: só supervisores, agentes e consultas (e ele próprio, sem mudar o papel).
  const canTouch = (m: TenantUser) => canManage && (isConfigAdmin(user?.role) || MANAGER_ASSIGNABLE.has(m.role) || m.id === user?.id);

  return (
    <>
      <Header
        title={t('team.title')}
        actions={
          canManage && (
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>
              {t('team.newUser')}
            </Button>
          )
        }
      />

      <div className="p-6 max-w-2xl space-y-4">
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 flex gap-3">
          <Shield className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-blue-700">
            <p><Trans i18nKey="team.legendOwner" components={[<strong key="0" />]} /></p>
            <p><Trans i18nKey="team.legendAdmin" components={[<strong key="0" />]} /></p>
            <p><Trans i18nKey="team.legendSupervisor" components={[<strong key="0" />]} /></p>
            <p><Trans i18nKey="team.legendMember" components={[<strong key="0" />]} /></p>
            <p><Trans i18nKey="team.legendViewer" components={[<strong key="0" />]} /></p>
          </div>
        </div>

        {isLoading ? (
          <PageSpinner />
        ) : (
          <Card padding={false}>
            <div className="divide-y divide-gray-100">
              {team?.map((member) => (
                <div key={member.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700 text-sm font-semibold">
                    {member.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-[10rem] flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-gray-900">{member.name}</p>
                      {member.id === user?.id && (
                        <span className="shrink-0 text-xs text-gray-400">{t('team.you')}</span>
                      )}
                    </div>
                    <p className="truncate text-xs text-gray-400">{member.email}</p>
                  </div>
                  <div className="ml-auto flex items-center gap-3">
                    <Badge className={ROLE_COLORS[member.role]}>{t(ROLE_LABEL_KEYS[member.role])}</Badge>
                    {member.twoFaEnabled && (
                      <Badge className="bg-emerald-100 text-emerald-700">2FA</Badge>
                    )}
                    {/* Turnos: gestor/admin de todos; supervisor da sua equipa (a API confirma) */}
                    {(canManage || user?.role === 'SUPERVISOR') && !isConfigAdmin(member.role) && member.role !== 'MANAGER' && (
                      <Button size="sm" variant="ghost" icon={<CalendarClock className="h-3.5 w-3.5" />} onClick={() => setShiftsFor(member)}>{t('team.shifts')}</Button>
                    )}
                    {canTouch(member) && (
                      <Button size="sm" variant="ghost" onClick={() => setEditing(member)}>{t('common.edit')}</Button>
                    )}
                    {canTouch(member) && member.id !== user?.id && member.role !== 'OWNER' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
                        loading={remove.isPending}
                        onClick={() => {
                          if (confirm(t('team.removeConfirm', { name: member.name }))) remove.mutate(member.id);
                        }}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      <MemberModal open={editing !== null} member={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      <ShiftsModal user={shiftsFor} onClose={() => setShiftsFor(null)} />
    </>
  );
}
