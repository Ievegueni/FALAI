import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ToggleRight } from 'lucide-react';
import { featuresApi, type FeatureMatrix } from '@/lib/api';
import { Card, Input, PageSpinner, EmptyState, Badge } from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';
import type { FeatureKey } from '@/types';

/**
 * Funcionalidades de todos os clientes num só sítio. Cada célula grava logo
 * (PATCH só dessa chave) e a API passa a bloquear/permitir em ~10 s.
 */
export function FeaturesPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({ queryKey: ['feature-matrix'], queryFn: featuresApi.matrix });

  const toggle = useMutation({
    mutationFn: ({ tenantId, key, value }: { tenantId: string; key: FeatureKey; value: boolean }) =>
      featuresApi.set(tenantId, { [key]: value }),
    // Actualização optimista: a matriz não pisca a cada clique.
    onMutate: async ({ tenantId, key, value }) => {
      await qc.cancelQueries({ queryKey: ['feature-matrix'] });
      const prev = qc.getQueryData<FeatureMatrix>(['feature-matrix']);
      qc.setQueryData<FeatureMatrix>(['feature-matrix'], (m) =>
        m && {
          ...m,
          tenants: m.tenants.map((t) =>
            t.id === tenantId ? { ...t, features: { ...t.features, [key]: value }, overrides: { ...t.overrides, [key]: value } } : t,
          ),
        },
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['feature-matrix'], ctx.prev);
      toast.error('Não foi possível guardar');
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['feature-matrix'] });
      void qc.invalidateQueries({ queryKey: ['tenant'] });
    },
  });

  const tenants = useMemo(
    () => (data?.tenants ?? []).filter((t) => t.name.toLowerCase().includes(search.toLowerCase())),
    [data, search],
  );

  if (isLoading) return <PageSpinner />;

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Funcionalidades</h1>
        <p className="text-sm text-gray-500">
          O que cada cliente pode usar. Desligado = some do CRM e a API responde 403. Cinzento = o plano não inclui.
        </p>
      </div>

      <div className="max-w-sm">
        <Input placeholder="Pesquisar cliente…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {tenants.length === 0 ? (
        <EmptyState icon={<ToggleRight className="h-8 w-8" />} title="Sem clientes" />
      ) : (
        <Card padding={false}>
          <div className="overflow-x-auto">
            <table className="text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="sticky left-0 z-10 bg-gray-50 px-4 py-3 text-left font-medium">Cliente</th>
                  {data!.features.map((f) => (
                    <th key={f.key} className="px-2 py-3 text-center font-medium" title={f.hint}>
                      <span className="block w-20 leading-tight">{f.label.replace(/ \(.*\)$/, '')}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {tenants.map((t) => (
                  <tr key={t.id} className="hover:bg-gray-50">
                    <td className="sticky left-0 z-10 bg-white px-4 py-2.5">
                      <Link to={`/tenants/${t.id}`} className="font-medium text-gray-900 hover:text-indigo-600">{t.name}</Link>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
                        {t.plan?.name ?? 'Sem plano'}
                        {t.status !== 'ACTIVE' && <Badge className="bg-amber-100 text-amber-700">{t.status}</Badge>}
                      </div>
                    </td>
                    {data!.features.map((f) => {
                      const locked = t.lockedByPlan.includes(f.key);
                      const on = !locked && t.features[f.key];
                      return (
                        <td key={f.key} className="px-2 py-2.5 text-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 cursor-pointer rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                            checked={on}
                            disabled={locked}
                            title={locked ? 'O plano deste cliente não inclui' : `${f.label}: ${on ? 'ligado' : 'desligado'}`}
                            aria-label={`${f.label} — ${t.name}`}
                            onChange={(e) => toggle.mutate({ tenantId: t.id, key: f.key, value: e.target.checked })}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
