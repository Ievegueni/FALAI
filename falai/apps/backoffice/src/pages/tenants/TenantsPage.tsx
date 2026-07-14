import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, Building2 } from 'lucide-react';
import { tenantsApi } from '@/lib/api';
import { Card, Input, Button, Badge, Pagination, EmptyState, PageSpinner } from '@/components/ui';
import { formatAOA, formatDate, tenantStatusColor, tenantStatusLabel } from '@/lib/utils';
import type { TenantStatus } from '@/types';

export function TenantsPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<TenantStatus | ''>('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'tenants', page, search, status],
    queryFn: () => tenantsApi.list({ page, perPage: 20, search: search || undefined, status: status || undefined }),
  });

  if (isLoading && !data) return <PageSpinner />;

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Tenants</h1>
          <p className="text-sm text-gray-500">{data?.total ?? 0} organizações registadas</p>
        </div>
        <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/tenants/new')}>
          Novo tenant
        </Button>
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <Input
            placeholder="Pesquisar por nome ou email…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            icon={<Search className="h-4 w-4" />}
          />
        </div>
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value as TenantStatus | ''); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        >
          <option value="">Todos os status</option>
          <option value="TRIAL">Trial</option>
          <option value="ACTIVE">Activo</option>
          <option value="SUSPENDED">Suspenso</option>
          <option value="CLOSED">Encerrado</option>
        </select>
      </div>

      <Card padding={false}>
        {(data?.data ?? []).length === 0 ? (
          <EmptyState icon={<Building2 className="h-8 w-8" />} title="Nenhum tenant encontrado" />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  {['Nome', 'Status', 'Plano', 'Saldo', 'Limite crédito', 'Criado em'].map((h) => (
                    <th key={h} className="px-6 py-3 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(data?.data ?? []).map((t) => (
                  <tr
                    key={t.id}
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => navigate(`/tenants/${t.id}`)}
                  >
                    <td className="px-6 py-3">
                      <p className="font-medium text-gray-900">{t.name}</p>
                    </td>
                    <td className="px-6 py-3">
                      <Badge className={tenantStatusColor[t.status as TenantStatus]}>
                        {tenantStatusLabel[t.status as TenantStatus] ?? t.status}
                      </Badge>
                    </td>
                    <td className="px-6 py-3 text-gray-600">{t.plan?.name ?? '–'}</td>
                    <td className="px-6 py-3 text-gray-600">{formatAOA(t.balanceCents)}</td>
                    <td className="px-6 py-3 text-gray-600">{formatAOA(t.creditLimitCents)}</td>
                    <td className="px-6 py-3 text-gray-500">{formatDate(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} total={data?.total ?? 0} perPage={20} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
