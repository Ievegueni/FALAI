import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, ShieldCheck } from 'lucide-react';
import { tenantsApi } from '@/lib/api';
import { Card, Button, Modal, Input, PageSpinner, EmptyState } from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';
import type { AccessLevel, AccessProfile, ProfileKey, TenantFeatures } from '@/types';

/**
 * Perfis de acesso ao CRM do cliente. Cada perfil diz, por módulo, se o
 * utilizador não o vê, só consulta ou pode alterar. A API aplica-o em todas as
 * rotas do módulo (ver apps/api/src/services/accessProfiles.ts); o OWNER nunca
 * é restringido.
 */

const LEVELS: { value: AccessLevel; label: string; active: string }[] = [
  { value: 'none', label: 'Sem acesso', active: 'bg-gray-600 text-white' },
  { value: 'read', label: 'Ver', active: 'bg-amber-500 text-white' },
  { value: 'write', label: 'Editar', active: 'bg-indigo-600 text-white' },
];

const LEVEL_BADGE: Record<AccessLevel, string> = {
  none: 'bg-gray-100 text-gray-400 line-through',
  read: 'bg-amber-50 text-amber-700',
  write: 'bg-indigo-50 text-indigo-700',
};

type Draft = { name: string; description: string; permissions: Record<string, AccessLevel> };

function LevelPicker({ value, onChange, levels }: { value: AccessLevel; onChange: (v: AccessLevel) => void; levels?: AccessLevel[] }) {
  return (
    <div className="inline-flex shrink-0 overflow-hidden rounded-lg border border-gray-200">
      {LEVELS.filter((l) => !levels || levels.includes(l.value)).map((l) => (
        <button
          key={l.value}
          type="button"
          onClick={() => onChange(l.value)}
          className={`px-3 py-1 text-xs font-medium transition-colors ${
            value === l.value ? l.active : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

export function TenantAccessProfilesTab({ tenantId, features }: { tenantId: string; features?: TenantFeatures }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['tenant-access-profiles', tenantId],
    queryFn: () => tenantsApi.accessProfiles(tenantId),
  });

  const [editing, setEditing] = useState<AccessProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>({ name: '', description: '', permissions: {} });

  const modules = data?.modules ?? [];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tenant-access-profiles', tenantId] });
    void qc.invalidateQueries({ queryKey: ['admin', 'tenant', tenantId] });
  };

  function openNew() {
    setEditing(null);
    // Perfil novo começa só com consulta: é mais seguro alargar do que esquecer de fechar.
    setDraft({ name: '', description: '', permissions: Object.fromEntries(modules.map((m) => [m.key, 'read'])) });
    setOpen(true);
  }

  function openEdit(p: AccessProfile) {
    setEditing(p);
    setDraft({ name: p.name, description: p.description ?? '', permissions: { ...p.permissions } });
    setOpen(true);
  }

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        permissions: draft.permissions as Record<ProfileKey, AccessLevel>,
      };
      return editing
        ? tenantsApi.updateAccessProfile(tenantId, editing.id, body)
        : tenantsApi.createAccessProfile(tenantId, body);
    },
    onSuccess: () => {
      toast.success(editing ? 'Perfil actualizado' : 'Perfil criado');
      setOpen(false);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (profileId: string) => tenantsApi.deleteAccessProfile(tenantId, profileId),
    onSuccess: () => { toast.success('Perfil eliminado'); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });

  // Módulos com menos níveis (ex.: Dashboard só tem Sem acesso / Ver) ficam no mais alto que têm
  const setAll = (level: AccessLevel) =>
    setDraft((d) => ({
      ...d,
      permissions: Object.fromEntries(
        modules.map((m): [string, AccessLevel] => [m.key, !m.levels || m.levels.includes(level) ? level : m.levels[m.levels.length - 1]!]),
      ),
    }));

  if (isLoading || !data) return <PageSpinner />;

  return (
    <Card padding={false}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">Perfis de acesso</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            O que cada utilizador do CRM pode ver e alterar, por módulo. Atribui-se no separador Utilizadores.
            O proprietário tem sempre acesso total.
          </p>
        </div>
        <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={openNew}>Novo perfil</Button>
      </div>

      {data.profiles.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="h-8 w-8" />}
          title="Sem perfis"
          description="Sem perfil, os utilizadores vêem todos os módulos que o cliente tem activos."
        />
      ) : (
        <div className="divide-y divide-gray-100">
          {data.profiles.map((p) => (
            <div key={p.id} className="flex items-start gap-4 px-6 py-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900">{p.name}</span>
                  <span className="text-xs text-gray-400">
                    {p._count.users === 1 ? '1 utilizador' : `${p._count.users} utilizadores`}
                  </span>
                </div>
                {p.description && <p className="text-xs text-gray-500 mt-0.5">{p.description}</p>}
                <div className="mt-2 flex flex-wrap gap-1">
                  {modules.map((m) => (
                    <span key={m.key} className={`rounded px-1.5 py-0.5 text-[11px] ${LEVEL_BADGE[p.permissions[m.key] ?? 'none']}`}>
                      {m.label}
                    </span>
                  ))}
                </div>
              </div>
              <Button size="sm" variant="outline" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => openEdit(p)}>
                Editar
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 className="h-4 w-4 text-red-500" />}
                loading={remove.isPending && remove.variables === p.id}
                onClick={() => { if (confirm(`Eliminar o perfil "${p.name}"?`)) remove.mutate(p.id); }}
              />
            </div>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title={editing ? `Editar perfil: ${editing.name}` : 'Novo perfil de acesso'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button loading={save.isPending} disabled={draft.name.trim().length < 2} onClick={() => save.mutate()}>
              {editing ? 'Guardar' : 'Criar'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Nome"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="ex.: Operador de atendimento"
            required
          />
          <Input
            label="Descrição (opcional)"
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            placeholder="ex.: Atende conversas e chamadas, não mexe na carteira"
          />
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium text-gray-700">Permissões por módulo</p>
              <div className="flex items-center gap-1 text-xs text-gray-500">
                Tudo:
                {LEVELS.map((l) => (
                  <button key={l.value} type="button" className="rounded px-1.5 py-0.5 hover:bg-gray-100 hover:text-gray-800" onClick={() => setAll(l.value)}>
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
              {modules.map((m) => {
                const off = features && m.key !== 'dashboard' ? features[m.key] === false : false;
                return (
                  <div key={m.key} className="flex items-center justify-between gap-4 px-3 py-2">
                    <div className="min-w-0">
                      <p className={`text-sm ${off ? 'text-gray-400' : 'text-gray-900'}`}>{m.label}</p>
                      <p className="text-xs text-gray-400 truncate">
                        {off ? 'Desligado para este cliente: não aparece a ninguém, seja qual for o perfil' : m.hint}
                      </p>
                    </div>
                    <LevelPicker
                      levels={m.levels}
                      value={draft.permissions[m.key] ?? 'none'}
                      onChange={(v) => setDraft((d) => ({ ...d, permissions: { ...d.permissions, [m.key]: v } }))}
                    />
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-gray-500">
              "Ver" deixa consultar mas bloqueia criar, alterar e apagar. As alterações aplicam-se em segundos,
              sem o utilizador ter de voltar a entrar (o menu actualiza no próximo carregamento da página).
            </p>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
