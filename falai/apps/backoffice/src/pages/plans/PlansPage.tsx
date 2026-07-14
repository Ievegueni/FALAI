import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, CreditCard } from 'lucide-react';
import { plansApi } from '@/lib/api';
import { Card, Button, PageSpinner, EmptyState, Modal, Input, Select, Badge } from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';
import { formatAOA } from '@/lib/utils';
import type { Plan, ProductType } from '@/types';

const PRODUCT_LABELS: Record<ProductType, string> = {
  VOICE_AI: 'Operador (PBX + IA)',
  CRM_BYO_PBX: 'CRM (PBX do cliente)',
};


function PlanModal({ plan, onClose }: { plan?: Plan; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(plan?.name ?? '');
  const [productType, setProductType] = useState<ProductType>(plan?.productType ?? 'VOICE_AI');
  const [aiAgentsEnabled, setAiAgentsEnabled] = useState(plan?.aiAgentsEnabled ?? true);
  const [pricePerMin, setPricePerMin] = useState(plan ? String(plan.pricePerMinCents / 100) : '');
  const [monthlyFee, setMonthlyFee] = useState(plan ? String((plan.monthlyFeeCents ?? 0) / 100) : '');
  const [maxConcurrent, setMaxConcurrent] = useState(plan ? String(plan.maxConcurrentCalls) : '1');
  const [maxAgents, setMaxAgents] = useState(plan ? String(plan.maxAgents) : '5');

  const mut = useMutation({
    mutationFn: () => {
      const body: Omit<Plan, 'id' | 'isActive'> = {
        name,
        productType,
        aiAgentsEnabled,
        pricePerMinCents: Math.round(parseFloat(pricePerMin) * 100),
        monthlyFeeCents: Math.round(parseFloat(monthlyFee) * 100),
        maxConcurrentCalls: parseInt(maxConcurrent),
        maxAgents: parseInt(maxAgents),
      };
      return plan ? plansApi.update(plan.id, body) : plansApi.create(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'plans'] });
      toast.success(plan ? 'Plano actualizado.' : 'Plano criado.');
      onClose();
    },
    onError: () => toast.error('Erro ao guardar plano.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={plan ? 'Editar plano' : 'Novo plano'}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button loading={mut.isPending} onClick={() => mut.mutate()}>Guardar</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Nome" value={name} onChange={(e) => setName(e.target.value)} required />
        <Select label="Tipo de produto" value={productType} onChange={(e) => setProductType(e.target.value as ProductType)}>
          <option value="VOICE_AI">{PRODUCT_LABELS.VOICE_AI}</option>
          <option value="CRM_BYO_PBX">{PRODUCT_LABELS.CRM_BYO_PBX}</option>
        </Select>
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={aiAgentsEnabled}
            onChange={(e) => setAiAgentsEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          Agentes de IA (o cliente pode criar e usar agentes de voz IA)
        </label>
        <Input label="Preço por minuto (Kz)" type="number" value={pricePerMin} onChange={(e) => setPricePerMin(e.target.value)} required />
        <Input label="Fee mensal (Kz)" type="number" value={monthlyFee} onChange={(e) => setMonthlyFee(e.target.value)} required />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Max. chamadas simult." type="number" value={maxConcurrent} onChange={(e) => setMaxConcurrent(e.target.value)} />
          <Input label="Max. agentes" type="number" value={maxAgents} onChange={(e) => setMaxAgents(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

export function PlansPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [modal, setModal] = useState<'new' | Plan | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'plans'],
    queryFn: () => plansApi.list(),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => plansApi.delete(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'plans'] }); toast.success('Plano removido.'); },
    onError: () => toast.error('Não foi possível remover o plano.'),
  });

  if (isLoading) return <PageSpinner />;

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Planos</h1>
          <p className="text-sm text-gray-500">Configuração dos planos de subscrição</p>
        </div>
        <Button icon={<Plus className="h-4 w-4" />} onClick={() => setModal('new')}>
          Novo plano
        </Button>
      </div>

      {(data ?? []).length === 0 ? (
        <Card>
          <EmptyState icon={<CreditCard className="h-8 w-8" />} title="Nenhum plano configurado"
            action={{ label: 'Criar plano', onClick: () => setModal('new'), icon: <Plus className="h-4 w-4" /> }} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {(data ?? []).map((plan) => (
            <Card key={plan.id}>
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-base font-semibold text-gray-900">{plan.name}</h3>
                  <div className="flex flex-wrap gap-1 mt-1">
                    <Badge className={plan.productType === 'CRM_BYO_PBX' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}>
                      {PRODUCT_LABELS[plan.productType]}
                    </Badge>
                    <Badge className={plan.aiAgentsEnabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}>
                      {plan.aiAgentsEnabled ? 'Com IA' : 'Sem IA'}
                    </Badge>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => setModal(plan)} className="rounded p-1 text-gray-400 hover:bg-gray-100"><Pencil className="h-4 w-4" /></button>
                  <button onClick={() => { if (confirm('Remover plano?')) deleteMut.mutate(plan.id); }} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-500"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-gray-500">Preço/min</dt><dd className="font-medium">{formatAOA(plan.pricePerMinCents ?? 0)}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Fee mensal</dt><dd className="font-medium">{formatAOA(plan.monthlyFeeCents)}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Max. simultâneas</dt><dd className="font-medium">{plan.maxConcurrentCalls}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Max. agentes</dt><dd className="font-medium">{plan.maxAgents}</dd></div>
              </dl>
            </Card>
          ))}
        </div>
      )}

      {modal !== null && (
        <PlanModal plan={modal === 'new' ? undefined : modal} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
