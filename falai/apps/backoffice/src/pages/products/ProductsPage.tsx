import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Package } from 'lucide-react';
import { productsApi } from '@/lib/api';
import { Card, Button, PageSpinner, EmptyState, Modal, Input, Textarea, Select, Badge } from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';
import { formatAOA } from '@/lib/utils';
import type { Product, ProductInput, ProductType } from '@/types';

// Os três tipos base: definem o comportamento (faturação, telefonia, CRM).
// Um produto do catálogo é sempre um destes por baixo.
export const BASE_TYPE_LABELS: Record<ProductType, string> = {
  VOICE_AI: 'Operador (PBX + IA)',
  CRM_BYO_PBX: 'CRM (PBX do cliente)',
  API_BYOM: 'API (modelo do cliente)',
};

export const BASE_TYPE_BADGE: Record<ProductType, string> = {
  VOICE_AI: 'bg-blue-100 text-blue-700',
  CRM_BYO_PBX: 'bg-purple-100 text-purple-700',
  API_BYOM: 'bg-teal-100 text-teal-700',
};

function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
      />
      {children}
    </label>
  );
}

function ProductModal({ product, onClose }: { product?: Product; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [baseType, setBaseType] = useState<ProductType>(product?.baseType ?? 'VOICE_AI');
  const [aiAgentsEnabled, setAiAgentsEnabled] = useState(product?.aiAgentsEnabled ?? true);
  const [clinicEnabled, setClinicEnabled] = useState(product?.clinicEnabled ?? false);
  const [smsEnabled, setSmsEnabled] = useState(product?.smsEnabled ?? false);
  const [monthlyFee, setMonthlyFee] = useState(product ? String(product.monthlyFeeCents / 100) : '');
  const [isActive, setIsActive] = useState(product?.isActive ?? true);

  const baseTypeChanged = !!product && product.planCount > 0 && baseType !== product.baseType;

  const mut = useMutation({
    mutationFn: () => {
      const body: ProductInput = {
        name: name.trim(),
        description: description.trim() || null,
        baseType,
        aiAgentsEnabled,
        clinicEnabled,
        smsEnabled,
        monthlyFeeCents: Math.round(parseFloat(monthlyFee || '0') * 100),
        isActive,
      };
      return product ? productsApi.update(product.id, body) : productsApi.create(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'products'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'plans'] });
      toast.success(product ? 'Produto actualizado.' : 'Produto criado.');
      onClose();
    },
    onError: () => toast.error('Erro ao guardar produto.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={product ? 'Editar produto' : 'Novo produto'}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button loading={mut.isPending} disabled={!name.trim()} onClick={() => mut.mutate()}>Guardar</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Nome" value={name} onChange={(e) => setName(e.target.value)} required />
        <Textarea label="Descrição" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        <Select
          label="Tipo base"
          value={baseType}
          onChange={(e) => setBaseType(e.target.value as ProductType)}
          hint="Define como o produto funciona: faturação, telefonia e acesso ao CRM."
        >
          <option value="VOICE_AI">{BASE_TYPE_LABELS.VOICE_AI}</option>
          <option value="CRM_BYO_PBX">{BASE_TYPE_LABELS.CRM_BYO_PBX}</option>
          <option value="API_BYOM">{BASE_TYPE_LABELS.API_BYOM}</option>
        </Select>
        {baseTypeChanged && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Este produto tem {product.planCount} plano(s). Mudar o tipo base muda também o comportamento
            dos clientes nesses planos.
          </p>
        )}
        <p className="text-xs font-medium text-gray-500">Defaults sugeridos ao criar um plano</p>
        <Checkbox checked={aiAgentsEnabled} onChange={setAiAgentsEnabled}>Agentes de IA</Checkbox>
        <Checkbox checked={clinicEnabled} onChange={setClinicEnabled}>Módulo Clínica</Checkbox>
        <Checkbox checked={smsEnabled} onChange={setSmsEnabled}>SMS</Checkbox>
        <Input label="Fee mensal base (Kz)" type="number" value={monthlyFee} onChange={(e) => setMonthlyFee(e.target.value)} />
        <Checkbox checked={isActive} onChange={setIsActive}>Activo (disponível para novos planos)</Checkbox>
      </div>
    </Modal>
  );
}

export function ProductsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [modal, setModal] = useState<'new' | Product | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'products'],
    queryFn: () => productsApi.list(),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => productsApi.delete(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'products'] }); toast.success('Produto removido.'); },
    onError: (err: Error) => toast.error(err.message || 'Não foi possível remover o produto.'),
  });

  if (isLoading) return <PageSpinner />;

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Produtos</h1>
          <p className="text-sm text-gray-500">Catálogo de produtos. Cada plano pertence a um produto.</p>
        </div>
        <Button icon={<Plus className="h-4 w-4" />} onClick={() => setModal('new')}>
          Novo produto
        </Button>
      </div>

      {(data ?? []).length === 0 ? (
        <Card>
          <EmptyState icon={<Package className="h-8 w-8" />} title="Nenhum produto configurado"
            action={{ label: 'Criar produto', onClick: () => setModal('new'), icon: <Plus className="h-4 w-4" /> }} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {(data ?? []).map((product) => (
            <Card key={product.id} className={product.isActive ? undefined : 'opacity-60'}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-base font-semibold text-gray-900">{product.name}</h3>
                  <div className="flex flex-wrap gap-1 mt-1">
                    <Badge className={BASE_TYPE_BADGE[product.baseType]}>{BASE_TYPE_LABELS[product.baseType]}</Badge>
                    {!product.isActive && <Badge className="bg-gray-100 text-gray-600">Inactivo</Badge>}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => setModal(product)} className="rounded p-1 text-gray-400 hover:bg-gray-100"><Pencil className="h-4 w-4" /></button>
                  <button
                    onClick={() => { if (confirm('Remover produto?')) deleteMut.mutate(product.id); }}
                    disabled={product.planCount > 0}
                    title={product.planCount > 0 ? 'Tem planos associados' : undefined}
                    className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-500 disabled:opacity-30 disabled:hover:text-gray-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              {product.description && <p className="mb-3 text-sm text-gray-600">{product.description}</p>}
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-gray-500">Planos</dt><dd className="font-medium">{product.planCount}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Fee mensal base</dt><dd className="font-medium">{formatAOA(product.monthlyFeeCents)}</dd></div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Módulos</dt>
                  <dd className="font-medium">
                    {[product.aiAgentsEnabled && 'IA', product.clinicEnabled && 'Clínica', product.smsEnabled && 'SMS'].filter(Boolean).join(', ') || 'Nenhum'}
                  </dd>
                </div>
              </dl>
            </Card>
          ))}
        </div>
      )}

      {modal !== null && (
        <ProductModal product={modal === 'new' ? undefined : modal} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
