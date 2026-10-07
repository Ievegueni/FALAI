import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Search, Ticket as TicketIcon, PlugZap } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { isOpsManager } from '@/lib/roles';
import { ticketsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageSpinner } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { formatDate } from '@/lib/utils';
import {
  CreateTicketModal,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TicketPriorityBadge,
  TicketStatusBadge,
  selectCls,
  useTicketMeta,
} from '@/components/tickets/TicketBits';

export function TicketsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [f, setF] = useState({ status: 'active', priority: '', supportLevel: '', assignee: '', groupId: '', q: '', page: 1 });
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch, page: patch.page ?? 1 }));
  const [showCreate, setShowCreate] = useState(false);
  const { data: meta } = useTicketMeta();

  const { data, isLoading } = useQuery({
    queryKey: ['tickets', f],
    queryFn: () =>
      ticketsApi.list({
        ...(f.status && { status: f.status }),
        ...(f.priority && { priority: f.priority }),
        ...(f.supportLevel && { supportLevel: Number(f.supportLevel) }),
        ...(f.assignee && { assignee: f.assignee }),
        ...(f.groupId && { groupId: f.groupId }),
        ...(f.q && { q: f.q }),
        page: f.page,
      }),
  });

  return (
    <>
      <Header
        title={t('tickets.title')}
        actions={
          <>
            {isOpsManager(user?.role) && (
              <Button size="sm" variant="outline" icon={<PlugZap className="h-3.5 w-3.5" />} onClick={() => navigate('/tickets/helpdesk')}>{t('helpdesk.title')}</Button>
            )}
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setShowCreate(true)}>{t('tickets.new')}</Button>
          </>
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-56">
            <Input placeholder={t('tickets.searchPlaceholder')} icon={<Search className="h-4 w-4" />} value={f.q} onChange={(e) => set({ q: e.target.value })} />
          </div>
          <select className={selectCls} value={f.status} onChange={(e) => set({ status: e.target.value })} aria-label={t('tickets.statusLabel')}>
            <option value="active">{t('tickets.filterActive')}</option>
            <option value="">{t('tickets.filterAll')}</option>
            {TICKET_STATUSES.map((s) => <option key={s} value={s}>{t(`tickets.status.${s}`)}</option>)}
          </select>
          <select className={selectCls} value={f.priority} onChange={(e) => set({ priority: e.target.value })} aria-label={t('tickets.priorityLabel')}>
            <option value="">{t('tickets.anyPriority')}</option>
            {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{t(`tickets.priority.${p}`)}</option>)}
          </select>
          <select className={selectCls} value={f.supportLevel} onChange={(e) => set({ supportLevel: e.target.value })} aria-label={t('tickets.level')}>
            <option value="">{t('tickets.anyLevel')}</option>
            {[1, 2, 3].map((l) => <option key={l} value={l}>{t('tickets.levelN', { n: l })}</option>)}
          </select>
          <select className={selectCls} value={f.assignee} onChange={(e) => set({ assignee: e.target.value })} aria-label={t('tickets.assignee')}>
            <option value="">{t('tickets.anyAssignee')}</option>
            <option value="me">{t('tickets.mine')}</option>
            <option value="none">{t('tickets.unassigned')}</option>
            {meta?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          {(meta?.groups.length ?? 0) > 0 && (
            <select className={selectCls} value={f.groupId} onChange={(e) => set({ groupId: e.target.value })} aria-label={t('tickets.group')}>
              <option value="">{t('tickets.anyGroup')}</option>
              {meta!.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
        </div>

        {isLoading ? (
          <PageSpinner />
        ) : data?.data.length === 0 ? (
          <EmptyState
            icon={<TicketIcon className="h-8 w-8" />}
            title={t('tickets.emptyTitle')}
            description={t('tickets.emptyDescription')}
            action={{ label: t('tickets.new'), icon: <Plus className="h-4 w-4" />, onClick: () => setShowCreate(true) }}
          />
        ) : (
          <Card padding={false}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px]">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    {['#', t('tickets.subject'), t('tickets.contact'), t('tickets.statusLabel'), t('tickets.priorityLabel'), t('tickets.level'), t('tickets.assignee'), t('tickets.updated')].map((h, i) => (
                      <th key={i} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data?.data.map((tk) => (
                    <tr key={tk.id} className="cursor-pointer hover:bg-gray-50" onClick={() => navigate(`/tickets/${tk.id}`)}>
                      <td className="px-4 py-3 text-sm text-gray-400">{tk.number}</td>
                      <td className="max-w-xs px-4 py-3">
                        <p className="truncate text-sm font-medium text-gray-900">{tk.subject}</p>
                        {tk.category && <p className="truncate text-xs text-gray-400">{[tk.category.name, tk.subcategory?.name].filter(Boolean).join(' › ')}</p>}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{tk.contact?.name || tk.contact?.phone || '—'}</td>
                      <td className="px-4 py-3"><TicketStatusBadge status={tk.status} /></td>
                      <td className="px-4 py-3"><TicketPriorityBadge priority={tk.priority} /></td>
                      <td className="px-4 py-3 text-sm text-gray-600">{t('tickets.levelN', { n: tk.supportLevel })}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{tk.assignee?.name ?? <span className="text-gray-400">{t('tickets.unassigned')}</span>}</td>
                      <td className="px-4 py-3 text-xs text-gray-400">{formatDate(tk.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data && <Pagination page={data.page} total={data.total} perPage={data.perPage} onPage={(page) => set({ page })} />}
          </Card>
        )}
      </div>

      <CreateTicketModal open={showCreate} onClose={() => setShowCreate(false)} />
    </>
  );
}
