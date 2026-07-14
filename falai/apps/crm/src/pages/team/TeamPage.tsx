import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, UserCheck, Trash2, Shield } from 'lucide-react';
import { teamApi } from '@/lib/api';
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
import type { TenantRole } from '@/types';

const ROLE_LABELS: Record<TenantRole, string> = {
  OWNER: 'Proprietário',
  ADMIN: 'Admin',
  MEMBER: 'Membro',
  VIEWER: 'Leitor',
};

const ROLE_COLORS: Record<TenantRole, string> = {
  OWNER: 'bg-purple-100 text-purple-700',
  ADMIN: 'bg-blue-100 text-blue-700',
  MEMBER: 'bg-gray-100 text-gray-700',
  VIEWER: 'bg-slate-100 text-slate-600',
};

function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [form, setForm] = useState({ email: '', name: '', role: 'MEMBER' as TenantRole });

  const invite = useMutation({
    mutationFn: () => teamApi.invite(form),
    onSuccess: () => {
      success('Convite enviado');
      void qc.invalidateQueries({ queryKey: ['team'] });
      onClose();
      setForm({ email: '', name: '', role: 'MEMBER' });
    },
    onError: (e: Error) => error(e.message),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Convidar membro"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button loading={invite.isPending} onClick={() => invite.mutate()}>Convidar</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label="Email"
          type="email"
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          placeholder="colega@empresa.ao"
          required
          autoFocus
        />
        <Input
          label="Nome"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="Nome do colega"
          required
        />
        <Select
          label="Papel"
          value={form.role}
          onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as TenantRole }))}
        >
          <option value="ADMIN">Admin — tudo excepto conta e OWNER</option>
          <option value="MEMBER">Membro — operar campanhas/contactos</option>
          <option value="VIEWER">Leitor — só leitura</option>
        </Select>
      </div>
    </Modal>
  );
}

export function TeamPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [showInvite, setShowInvite] = useState(false);

  const { data: team, isLoading } = useQuery({
    queryKey: ['team'],
    queryFn: teamApi.list,
  });

  const remove = useMutation({
    mutationFn: (id: string) => teamApi.remove(id),
    onSuccess: () => { success('Membro removido'); void qc.invalidateQueries({ queryKey: ['team'] }); },
    onError: (e: Error) => error(e.message),
  });

  const canManage = user?.role === 'OWNER' || user?.role === 'ADMIN';

  return (
    <>
      <Header
        title="Equipa"
        actions={
          canManage && (
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setShowInvite(true)}>
              Convidar
            </Button>
          )
        }
      />

      <div className="p-6 max-w-2xl space-y-4">
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 flex gap-3">
          <Shield className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-blue-700">
            <p><strong>OWNER</strong> — acesso total, incluindo facturação e API keys.</p>
            <p><strong>ADMIN</strong> — tudo excepto eliminar a conta e gerir o OWNER.</p>
            <p><strong>MEMBRO</strong> — operar campanhas, chamadas e contactos; sem carteira.</p>
            <p><strong>LEITOR</strong> — apenas dashboards, histórico e relatórios.</p>
          </div>
        </div>

        {isLoading ? (
          <PageSpinner />
        ) : (
          <Card padding={false}>
            <div className="divide-y divide-gray-100">
              {team?.map((member) => (
                <div key={member.id} className="flex items-center gap-4 px-6 py-3">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700 text-sm font-semibold">
                    {member.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-900">{member.name}</p>
                      {member.id === user?.id && (
                        <span className="text-xs text-gray-400">(você)</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400">{member.email}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge className={ROLE_COLORS[member.role]}>{ROLE_LABELS[member.role]}</Badge>
                    {member.twoFaEnabled && (
                      <Badge className="bg-emerald-100 text-emerald-700">2FA</Badge>
                    )}
                    {canManage && member.id !== user?.id && member.role !== 'OWNER' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
                        loading={remove.isPending}
                        onClick={() => {
                          if (confirm(`Remover ${member.name} da equipa?`)) remove.mutate(member.id);
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

      <InviteModal open={showInvite} onClose={() => setShowInvite(false)} />
    </>
  );
}
