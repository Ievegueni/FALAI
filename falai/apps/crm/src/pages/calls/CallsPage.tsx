import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Phone, PhoneCall, Plus, Search, Download } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { callsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageSpinner } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { callStatusLabel, callStatusColor, formatDate, formatDuration, formatAOA, formatPhone } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import type { Call, CallStatus } from '@/types';

const STATUS_VALUES: CallStatus[] = ['COMPLETED', 'NO_ANSWER', 'FAILED', 'IN_PROGRESS', 'CANCELLED', 'ESCALATED'];

function CallRow({ call }: { call: Call }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <tr
      className="hover:bg-gray-50 cursor-pointer"
      onClick={() => navigate(`/calls/${call.id}`)}
    >
      <td className="px-4 py-3">
        <p className="text-sm font-medium text-gray-900">{call.contact?.name ?? formatPhone(call.to)}</p>
        {call.contact && <p className="text-xs text-gray-400">{formatPhone(call.to)}</p>}
      </td>
      <td className="px-4 py-3 text-sm text-gray-600">
        {call.kind === 'OTP' ? (
          <Badge className="bg-indigo-100 text-indigo-700">{t('calls.otpVerification')}</Badge>
        ) : call.kind === 'DIRECT' ? (
          <Badge className="bg-slate-100 text-slate-600">{t('calls.directCall')}</Badge>
        ) : (
          call.agent?.name || '—'
        )}
      </td>
      <td className="px-4 py-3">
        <Badge className={callStatusColor[call.status]}>{callStatusLabel(call.status)}</Badge>
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        {call.outcome ? (
          <span className="truncate max-w-[160px] block">{call.outcome}</span>
        ) : '—'}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        {call.durationSecs !== null ? formatDuration(call.durationSecs) : '—'}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        {call.costCents !== null ? formatAOA(call.costCents) : '—'}
      </td>
      <td className="px-4 py-3 text-xs text-gray-400">{formatDate(call.createdAt)}</td>
    </tr>
  );
}

export function CallsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { tenant } = useAuth();
  // "Nova chamada" usa um agente de IA — só disponível quando o plano permite
  // agentes E a funcionalidade "agents" está activa para este cliente (senão a
  // rota /calls/new é bloqueada por RequireFeature e redirecciona ao dashboard).
  const aiEnabled = tenant?.plan?.aiAgentsEnabled !== false && tenant?.features?.agents !== false;
  const directEnabled = tenant?.features?.directCall !== false;
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<CallStatus | ''>('');

  const { data, isLoading } = useQuery({
    queryKey: ['calls', page, status],
    queryFn: () => callsApi.list({ page, status: status || undefined }),
  });

  return (
    <>
      <Header
        title={t('calls.title')}
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" icon={<PhoneCall className="h-3.5 w-3.5" />} onClick={() => navigate('/calls/direct')}>
              {t('calls.directCall')}
            </Button>
            {aiEnabled && (
              <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate('/calls/new')}>
                {t('calls.newCall')}
              </Button>
            )}
          </div>
        }
      />

      <div className="p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-52">
            <Select
              value={status}
              onChange={(e) => { setStatus(e.target.value as CallStatus | ''); setPage(1); }}
            >
              <option value="">{t('calls.allStatuses')}</option>
              {STATUS_VALUES.map((v) => (
                <option key={v} value={v}>{callStatusLabel(v)}</option>
              ))}
            </Select>
          </div>
          {data && <p className="text-sm text-gray-500">{t('calls.count', { count: data.total })}</p>}
          <div className="ml-auto">
            <Button size="sm" variant="outline" icon={<Download className="h-3.5 w-3.5" />}>
              {t('calls.exportCsv')}
            </Button>
          </div>
        </div>

        {isLoading ? (
          <PageSpinner />
        ) : data?.data.length === 0 ? (
          <EmptyState
            icon={<Phone className="h-8 w-8" />}
            title={t('calls.emptyTitle')}
            description={
              aiEnabled
                ? t('calls.emptyDescAi')
                : directEnabled
                  ? t('calls.emptyDescDirect')
                  : t('calls.emptyDescNone')
            }
            action={
              aiEnabled
                ? { label: t('calls.newCall'), icon: <Plus className="h-4 w-4" />, onClick: () => navigate('/calls/new') }
                : directEnabled
                  ? { label: t('calls.directCall'), icon: <PhoneCall className="h-4 w-4" />, onClick: () => navigate('/calls/direct') }
                  : undefined
            }
          />
        ) : (
          <Card padding={false}>
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {[t('calls.colContact'), t('calls.colAgent'), t('calls.colStatus'), t('calls.colOutcome'), t('calls.colDuration'), t('calls.colCost'), t('calls.colDate')].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data?.data.map((c) => <CallRow key={c.id} call={c} />)}
              </tbody>
            </table>
            {data && <Pagination page={page} total={data.total} perPage={data.perPage} onPage={setPage} />}
          </Card>
        )}
      </div>
    </>
  );
}
