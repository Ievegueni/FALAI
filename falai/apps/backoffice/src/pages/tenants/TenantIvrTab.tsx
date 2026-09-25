import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ListTree, PhoneIncoming } from 'lucide-react';
import { tenantsApi } from '@/lib/api';
import { Card, Button, Modal, Input, Select, Textarea, PageSpinner } from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';
import type { InboundRoute, IvrDestType, IvrMenu, IvrOption } from '@/types';

/**
 * Menus IVR e rotas de entrada do cliente, geridos pelo operador — mesmas
 * rotas e validação que o CRM (ver apps/api/src/routes/shared/ivrRouting.ts).
 */

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'];
const TYPE_LABEL: Record<string, string> = { EXTENSION: 'Extensão', GROUP: 'Grupo', IVR: 'Menu IVR', AI_AGENT: 'IA' };

function useDestinations(tenantId: string) {
  const opts = useQuery({ queryKey: ['tenant-routing-options', tenantId], queryFn: () => tenantsApi.routingOptions(tenantId) });
  const ivr = useQuery({ queryKey: ['tenant-ivr', tenantId], queryFn: () => tenantsApi.listIvr(tenantId) });
  const options: Record<IvrDestType, { value: string; label: string }[]> = {
    EXTENSION: (opts.data?.extensions ?? []).map((e) => ({ value: e.number, label: `${e.number}${e.displayName ? ` — ${e.displayName}` : ''}` })),
    GROUP: (opts.data?.groups ?? []).map((g) => ({ value: g.id, label: g.name })),
    IVR: (ivr.data ?? []).map((m) => ({ value: m.id, label: m.name })),
  };
  const label = (type: string, value: string) =>
    options[type as IvrDestType]?.find((o) => o.value === value)?.label ?? value;
  return { options, label, trunks: opts.data?.trunks ?? [] };
}

function DestPicker({ tenantId, type, value, onChange, exclude }: {
  tenantId: string; type: IvrDestType; value: string; onChange: (type: IvrDestType, value: string) => void; exclude?: string;
}) {
  const { options } = useDestinations(tenantId);
  return (
    <div className="grid grid-cols-2 gap-2">
      <Select value={type} onChange={(e) => onChange(e.target.value as IvrDestType, '')}>
        <option value="EXTENSION">Extensão</option>
        <option value="GROUP">Grupo</option>
        <option value="IVR">Menu IVR</option>
      </Select>
      <Select value={value} onChange={(e) => onChange(type, e.target.value)}>
        <option value="">—</option>
        {options[type].filter((o) => o.value !== exclude).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </div>
  );
}

const EMPTY_MENU: Omit<IvrMenu, 'id'> = { name: '', greeting: '', options: [], timeoutSecs: 6, maxRetries: 2 };

function IvrModal({ tenantId, editing, onClose }: { tenantId: string; editing: IvrMenu | 'new'; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<Omit<IvrMenu, 'id'>>(editing === 'new' ? EMPTY_MENU : editing);

  const setOption = (i: number, patch: Partial<IvrOption>) =>
    setForm((f) => ({ ...f, options: f.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  const nextDigit = DIGITS.find((d) => !form.options.some((o) => o.digit === d));

  const save = useMutation({
    mutationFn: (): Promise<unknown> =>
      editing === 'new' ? tenantsApi.createIvr(tenantId, form) : tenantsApi.updateIvr(tenantId, editing.id, form),
    onSuccess: () => { toast.success('Menu gravado'); onClose(); },
    onError: (e: Error) => toast.error(e.message),
    // Uma falha do TTS grava o menu na mesma — a lista tem de o mostrar.
    onSettled: () => void qc.invalidateQueries({ queryKey: ['tenant-ivr', tenantId] }),
  });

  return (
    <Modal open onClose={onClose} title={editing === 'new' ? 'Novo menu IVR' : 'Editar menu IVR'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Guardar</Button></>}>
      <div className="space-y-4">
        <Input label="Nome" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Principal" required autoFocus />
        <Textarea label="Saudação" rows={3} value={form.greeting}
          hint="Texto lido ao chamador (convertido em voz ao gravar). Indique as opções, ex.: “prima 1 para vendas”."
          onChange={(e) => setForm((f) => ({ ...f, greeting: e.target.value }))}
          placeholder="Bem-vindo. Para vendas, prima 1. Para suporte, prima 2." />
        <div className="grid grid-cols-2 gap-4">
          <Input label="Espera por dígito (s)" type="number" min={2} max={30} value={form.timeoutSecs}
            onChange={(e) => setForm((f) => ({ ...f, timeoutSecs: Number(e.target.value) }))} />
          <Input label="Repetições" type="number" min={0} max={5} value={form.maxRetries}
            onChange={(e) => setForm((f) => ({ ...f, maxRetries: Number(e.target.value) }))} />
        </div>
        <div>
          <p className="text-sm font-medium text-gray-700 mb-2">Opções</p>
          <div className="space-y-2">
            {form.options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select className="w-16" value={o.digit} onChange={(e) => setOption(i, { digit: e.target.value })}>
                  {DIGITS.map((d) => <option key={d} value={d}>{d}</option>)}
                </Select>
                <div className="flex-1">
                  <DestPicker tenantId={tenantId} type={o.destType} value={o.destValue} exclude={editing === 'new' ? undefined : editing.id}
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
              Adicionar opção
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function InboundRouteModal({ tenantId, editing, onClose }: { tenantId: string; editing: InboundRoute | 'new'; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { trunks } = useDestinations(tenantId);
  const [form, setForm] = useState(
    editing === 'new'
      ? { name: '', trunkId: '', didPattern: '', destType: 'IVR' as IvrDestType, destValue: '' }
      : { name: editing.name, trunkId: editing.trunkId, didPattern: editing.didPattern, destType: editing.destType as IvrDestType, destValue: editing.destValue },
  );
  const trunkId = form.trunkId || trunks[0]?.id || '';

  const save = useMutation({
    mutationFn: (): Promise<unknown> => {
      const data = { ...form, trunkId };
      return editing === 'new' ? tenantsApi.createInboundRoute(tenantId, data) : tenantsApi.updateInboundRoute(tenantId, editing.id, data);
    },
    onSuccess: () => { toast.success('Rota gravada'); void qc.invalidateQueries({ queryKey: ['tenant-inbound', tenantId] }); onClose(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title={editing === 'new' ? 'Nova rota de entrada' : 'Editar rota de entrada'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Guardar</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Input label="Nome" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required autoFocus />
          <Input label="DID" value={form.didPattern} hint="Número completo ou prefixo"
            onChange={(e) => setForm((f) => ({ ...f, didPattern: e.target.value }))} placeholder="244222000000" required />
        </div>
        <Select label="Trunk" value={trunkId} onChange={(e) => setForm((f) => ({ ...f, trunkId: e.target.value }))}>
          {trunks.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
        </Select>
        <div>
          <p className="text-sm font-medium text-gray-700 mb-1.5">Destino</p>
          <DestPicker tenantId={tenantId} type={form.destType} value={form.destValue}
            onChange={(destType, destValue) => setForm((f) => ({ ...f, destType, destValue }))} />
        </div>
      </div>
    </Modal>
  );
}

export function TenantIvrTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { label } = useDestinations(tenantId);
  const [editingMenu, setEditingMenu] = useState<IvrMenu | 'new' | null>(null);
  const [editingRoute, setEditingRoute] = useState<InboundRoute | 'new' | null>(null);
  const menus = useQuery({ queryKey: ['tenant-ivr', tenantId], queryFn: () => tenantsApi.listIvr(tenantId) });
  const routes = useQuery({ queryKey: ['tenant-inbound', tenantId], queryFn: () => tenantsApi.listInboundRoutes(tenantId) });

  const removeMenu = useMutation({
    mutationFn: (menuId: string) => tenantsApi.deleteIvr(tenantId, menuId),
    onSuccess: () => { toast.success('Menu eliminado'); void qc.invalidateQueries({ queryKey: ['tenant-ivr', tenantId] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeRoute = useMutation({
    mutationFn: (routeId: string) => tenantsApi.deleteInboundRoute(tenantId, routeId),
    onSuccess: () => { toast.success('Rota eliminada'); void qc.invalidateQueries({ queryKey: ['tenant-inbound', tenantId] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (menus.isLoading || routes.isLoading) return <PageSpinner />;

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900">Menus IVR</h3>
          <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditingMenu('new')}>Novo menu</Button>
        </div>
        <Card padding={false}>
          <div className="divide-y divide-gray-100">
            {menus.data?.map((m) => (
              <div key={m.id} className="flex items-start gap-4 px-5 py-3">
                <ListTree className="h-4 w-4 text-gray-400 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">{m.name}</p>
                  <p className="text-xs text-gray-500 truncate">“{m.greeting}”</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {m.options.map((o) => `${o.digit} → ${label(o.destType, o.destValue)}`).join(' · ') || 'Sem opções'}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setEditingMenu(m)}>Editar</Button>
                <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
                  onClick={() => { if (confirm(`Eliminar o menu ${m.name}?`)) removeMenu.mutate(m.id); }} />
              </div>
            ))}
            {menus.data?.length === 0 && <div className="px-5 py-8 text-center text-gray-400 text-sm">Sem menus IVR.</div>}
          </div>
        </Card>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900">Rotas de entrada</h3>
          <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditingRoute('new')}>Nova rota</Button>
        </div>
        <Card padding={false}>
          <div className="divide-y divide-gray-100">
            {routes.data?.map((r) => (
              <div key={r.id} className="flex items-center gap-4 px-5 py-3">
                <PhoneIncoming className="h-4 w-4 text-gray-400" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">{r.name} <span className="font-mono text-xs text-gray-500">{r.didPattern}</span></p>
                  <p className="text-xs text-gray-400">{r.trunkName} → {TYPE_LABEL[r.destType]}: {label(r.destType, r.destValue)}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setEditingRoute(r)}>Editar</Button>
                <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
                  onClick={() => { if (confirm(`Eliminar a rota ${r.name}?`)) removeRoute.mutate(r.id); }} />
              </div>
            ))}
            {routes.data?.length === 0 && <div className="px-5 py-8 text-center text-gray-400 text-sm">Sem rotas de entrada.</div>}
          </div>
        </Card>
      </section>

      {editingMenu && <IvrModal tenantId={tenantId} editing={editingMenu} onClose={() => setEditingMenu(null)} />}
      {editingRoute && <InboundRouteModal tenantId={tenantId} editing={editingRoute} onClose={() => setEditingRoute(null)} />}
    </div>
  );
}
