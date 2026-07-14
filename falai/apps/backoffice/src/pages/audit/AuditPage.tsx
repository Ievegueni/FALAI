import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, ScrollText } from 'lucide-react';
import { auditApi } from '@/lib/api';
import { Card, Input, Badge, PageSpinner, EmptyState, Pagination } from '@/components/ui';
import { formatDate } from '@/lib/utils';

export function AuditPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [actorType, setActorType] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'audit', page, search, actorType],
    queryFn: () => auditApi.list({ page, perPage: 25, search: search || undefined, actorType: actorType || undefined }),
  });

  if (isLoading && !data) return <PageSpinner />;

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Audit Log</h1>
        <p className="text-sm text-gray-500">Registo imutável de todas as acções administrativas</p>
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <Input
            placeholder="Pesquisar acção, actor, recurso…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            icon={<Search className="h-4 w-4" />}
          />
        </div>
        <select
          value={actorType}
          onChange={(e) => { setActorType(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        >
          <option value="">Todos os actores</option>
          <option value="ADMIN">Admin</option>
          <option value="TENANT_USER">Tenant User</option>
          <option value="SYSTEM">Sistema</option>
        </select>
      </div>

      <Card padding={false}>
        {(data?.data ?? []).length === 0 ? (
          <EmptyState icon={<ScrollText className="h-8 w-8" />} title="Nenhum registo encontrado" />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  {['Quando', 'Actor', 'Acção', 'Recurso', 'Tenant', 'IP'].map((h) => (
                    <th key={h} className="px-6 py-3 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(data?.data ?? []).map((log) => (
                  <tr key={log.id} className="hover:bg-gray-50">
                    <td className="px-6 py-3 text-gray-500 whitespace-nowrap">{formatDate(log.createdAt)}</td>
                    <td className="px-6 py-3">
                      <div>
                        <p className="font-medium text-gray-900 text-xs">{log.actorId}</p>
                        <Badge className={log.actorType === 'ADMIN' ? 'bg-indigo-100 text-indigo-700 mt-0.5' : log.actorType === 'SYSTEM' ? 'bg-gray-100 text-gray-600 mt-0.5' : 'bg-blue-100 text-blue-700 mt-0.5'}>
                          {log.actorType}
                        </Badge>
                      </div>
                    </td>
                    <td className="px-6 py-3">
                      <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-gray-800">{log.action}</code>
                    </td>
                    <td className="px-6 py-3 text-gray-600 text-xs">
                      {log.targetType && <span className="text-gray-400">{log.targetType} </span>}
                      {log.targetId && <span className="font-mono">{log.targetId.slice(0, 8)}…</span>}
                    </td>
                    <td className="px-6 py-3 text-gray-500 text-xs">{log.tenantId ? log.tenantId.slice(0, 8) + '…' : '–'}</td>
                    <td className="px-6 py-3 text-gray-400 text-xs font-mono">{log.ip ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} total={data?.total ?? 0} perPage={25} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
