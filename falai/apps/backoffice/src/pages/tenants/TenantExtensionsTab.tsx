import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, PhoneCall, Star, KeyRound } from 'lucide-react';
import { tenantsApi } from '@/lib/api';
import { Card, Button, Modal, Input, Select, Badge, EmptyState, PageSpinner } from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';
import type { TenantExtension } from '@/types';

/**
 * Extensões do cliente, geridas pelo operador — as mesmas que o cliente vê no
 * CRM (Telefonia → Extensões). Mesmas rotas e validação que o CRM, ver
 * apps/api/src/routes/shared/extensions.ts.
 */

const EMPTY = { number: '', displayName: '', callerId: '', phoneNumber: '', isActive: true };

function ExtensionModal({ tenantId, editing, onClose, onSecret }: {
  tenantId: string;
  editing: TenantExtension | 'new';
  onClose: () => void;
  onSecret: (s: { number: string; user: string; secret: string }) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = editing === 'new';
  const [form, setForm] = useState(isNew ? EMPTY : {
    number: editing.number,
    displayName: editing.displayName ?? '',
    callerId: editing.callerId,
    phoneNumber: editing.phoneNumber ?? '',
    isActive: editing.isActive,
  });
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: async () => {
      const data = {
        displayName: form.displayName.trim() || null,
        ...(form.callerId.trim() ? { callerId: form.callerId.trim() } : {}),
        phoneNumber: form.phoneNumber.trim() || null,
      };
      if (isNew) {
        const ext = await tenantsApi.createExtension(tenantId, { number: form.number.trim(), ...data, displayName: data.displayName ?? undefined });
        onSecret({ number: ext.number, user: ext.sipAuthUser, secret: ext.sipAuthSecret });
        return;
      }
      await tenantsApi.updateExtension(tenantId, editing.id, { ...data, isActive: form.isActive });
    },
    onSuccess: () => {
      toast.success(isNew ? 'Extensão criada.' : 'Extensão actualizada.');
      void qc.invalidateQueries({ queryKey: ['tenant-extensions', tenantId] });
      void qc.invalidateQueries({ queryKey: ['tenant-routing-options', tenantId] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title={isNew ? 'Nova extensão' : `Editar extensão ${editing.number}`}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button loading={save.isPending} disabled={isNew && !/^\d{2,10}$/.test(form.number.trim())} onClick={() => save.mutate()}>
          {isNew ? 'Criar' : 'Guardar'}
        </Button>
      </>}>
      <div className="grid grid-cols-2 gap-4">
        <Input label="Extensão" value={form.number} onChange={(e) => set('number', e.target.value)} placeholder="1001"
          readOnly={!isNew} hint={isNew ? 'só dígitos' : 'não se muda depois de criada'} />
        <Input label="Nome" value={form.displayName} onChange={(e) => set('displayName', e.target.value)} placeholder="Atendimento" />
        <Input label="ID de chamador" value={form.callerId} onChange={(e) => set('callerId', e.target.value)} hint="vazio = número da extensão" />
        <Input label="DID associado" value={form.phoneNumber} onChange={(e) => set('phoneNumber', e.target.value)} hint="opcional" />
        {!isNew && (
          <Select label="Estado" value={form.isActive ? '1' : '0'} onChange={(e) => set('isActive', e.target.value === '1')}>
            <option value="1">Activa</option>
            <option value="0">Inactiva</option>
          </Select>
        )}
      </div>
    </Modal>
  );
}

export function TenantExtensionsTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<TenantExtension | 'new' | null>(null);
  // Credenciais SIP: o segredo só é devolvido ao criar ou regenerar.
  const [secret, setSecret] = useState<{ number: string; user: string; secret: string } | null>(null);
  const exts = useQuery({ queryKey: ['tenant-extensions', tenantId], queryFn: () => tenantsApi.listExtensions(tenantId) });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['tenant-extensions', tenantId] });
    void qc.invalidateQueries({ queryKey: ['tenant-routing-options', tenantId] });
  };
  const makeDefault = useMutation({
    mutationFn: (extId: string) => tenantsApi.updateExtension(tenantId, extId, { isDefault: true }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });
  const resetSip = useMutation({
    mutationFn: (extId: string) => tenantsApi.resetExtensionSip(tenantId, extId),
    onSuccess: (ext) => { setSecret({ number: ext.number, user: ext.sipAuthUser, secret: ext.sipAuthSecret }); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (extId: string) => tenantsApi.deleteExtension(tenantId, extId),
    onSuccess: () => { toast.success('Extensão eliminada'); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (exts.isLoading) return <PageSpinner />;

  return (
    <Card padding={false}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">Extensões</h2>
          <p className="text-xs text-gray-500 mt-0.5">As mesmas que o cliente vê no CRM. A extensão por defeito é a de saída nas campanhas.</p>
        </div>
        <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>Nova extensão</Button>
      </div>
      {(exts.data ?? []).length === 0 ? (
        <EmptyState icon={<PhoneCall className="h-8 w-8" />} title="Sem extensões" description="Cria a primeira extensão deste cliente." />
      ) : (
        <div className="divide-y divide-gray-100">
          {exts.data!.map((x) => (
            <div key={x.id} className="flex items-center gap-4 px-6 py-3">
              <PhoneCall className={`h-4 w-4 flex-shrink-0 ${x.isActive ? 'text-indigo-500' : 'text-gray-300'}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <button className="text-sm font-medium text-gray-900 hover:text-indigo-600" onClick={() => setEditing(x)}>
                    {x.number}{x.displayName && x.displayName !== x.number ? ` — ${x.displayName}` : ''}
                  </button>
                  {x.isDefault && (
                    <Badge className="bg-amber-100 text-amber-700 text-xs inline-flex items-center gap-1"><Star className="h-3 w-3" />Por defeito</Badge>
                  )}
                  {!x.isActive && <Badge className="bg-gray-100 text-gray-500 text-xs">Inactiva</Badge>}
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  SIP <code className="bg-gray-100 px-1 rounded">{x.sipAuthUser}</code>
                  {x.callerId !== x.number && <> · ID <code className="bg-gray-100 px-1 rounded">{x.callerId}</code></>}
                  {x.phoneNumber && <> · DID <code className="bg-gray-100 px-1 rounded">{x.phoneNumber}</code></>}
                </p>
              </div>
              {!x.isDefault && x.isActive && (
                <Button size="sm" variant="ghost" onClick={() => makeDefault.mutate(x.id)}>Tornar por defeito</Button>
              )}
              <Button size="sm" variant="ghost" icon={<KeyRound className="h-4 w-4" />}
                onClick={() => { if (confirm(`Gerar nova senha SIP para ${x.number}? Os telefones registados com a antiga deixam de funcionar.`)) resetSip.mutate(x.id); }}>
                Nova senha
              </Button>
              <button className="text-gray-400 hover:text-red-500" title="Eliminar"
                onClick={() => { if (confirm(`Eliminar a extensão ${x.number}?`)) remove.mutate(x.id); }}>
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {editing && <ExtensionModal tenantId={tenantId} editing={editing} onClose={() => setEditing(null)} onSecret={setSecret} />}
      {secret && (
        <Modal open onClose={() => setSecret(null)} title={`Credenciais SIP — extensão ${secret.number}`}
          footer={<Button onClick={() => setSecret(null)}>Fechar</Button>}>
          <p className="text-sm text-gray-600 mb-4">Guarda a senha agora: não volta a ser mostrada.</p>
          <div className="space-y-3">
            <Input label="Utilizador SIP" value={secret.user} readOnly />
            <Input label="Senha SIP" value={secret.secret} readOnly />
          </div>
        </Modal>
      )}
    </Card>
  );
}
