import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Phone, PhoneCall, PhoneIncoming, Plus, Search, FileSpreadsheet, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { callsApi, telephonyApi, callTypingApi, type CallsFilters } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageSpinner } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { callStatusLabel, callStatusColor, formatDate, formatDuration, formatAOA, formatPhone, clsx } from '@/lib/utils';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';
import type { Call, CallStatus } from '@/types';

const STATUS_VALUES: CallStatus[] = ['COMPLETED', 'NO_ANSWER', 'FAILED', 'IN_PROGRESS', 'CANCELLED', 'ESCALATED'];
const KINDS = ['INBOUND', 'AI_AGENT', 'DIRECT', 'FIXED_SCRIPT', 'OTP'] as const;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
};
/** Atalhos de período: "todo" = sem datas (comportamento antigo). */
const PERIODS = [
  { key: 'all', days: null },
  { key: 'today', days: 0 },
  { key: '7d', days: 6 },
  { key: '30d', days: 29 },
  { key: '90d', days: 89 },
] as const;
type PeriodKey = (typeof PERIODS)[number]['key'] | 'custom';

const selectCls = 'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700';

function saveBlob({ blob, filename }: { blob: Blob; filename: string }) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function CallRow({ call }: { call: Call }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <tr
      className="hover:bg-gray-50 cursor-pointer"
      onClick={() => navigate(`/calls/${call.id}`)}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {call.direction === 'inbound' && (
            <PhoneIncoming className="h-4 w-4 shrink-0 text-emerald-500" aria-label={t('calls.inbound')} />
          )}
          <div>
            <p className="text-sm font-medium text-gray-900">
              {call.contact?.name ?? formatPhone(call.party ?? call.to)}
            </p>
            {call.contact && <p className="text-xs text-gray-400">{formatPhone(call.party ?? call.to)}</p>}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-gray-600">
        {call.direction === 'inbound' ? (
          call.handledBy ? (
            <div>
              <p className="text-sm text-gray-900">{call.handledBy.name ?? call.handledBy.number}</p>
              <p className="text-xs text-gray-400">
                {t('calls.inbound')} · {call.handledBy.number}
                {call.typing && <span className="text-gray-500"> · {call.typing}</span>}
              </p>
            </div>
          ) : (
            <Badge className="bg-emerald-100 text-emerald-700">{t('calls.inbound')}</Badge>
          )
        ) : call.kind === 'OTP' ? (
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
        {/* O resultado só diz algo quando não repete o estado (ex. "interest" da IA). */}
        {call.outcome && call.outcome !== call.status ? (
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
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<CallStatus | ''>('');
  const [period, setPeriod] = useState<PeriodKey>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [direction, setDirection] = useState<'' | 'inbound' | 'outbound'>('');
  const [kind, setKind] = useState<'' | (typeof KINDS)[number]>('');
  const [extensionId, setExtensionId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [exporting, setExporting] = useState(false);

  // Pesquisa com 300 ms de folga: não pede à API a cada tecla.
  useEffect(() => {
    const id = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(id);
  }, [search]);

  const filters: CallsFilters & { status?: CallStatus } = {
    ...(from && { from }),
    ...(to && { to }),
    ...(direction && { direction }),
    ...(kind && { kind }),
    ...(extensionId && { extensionId }),
    ...(groupId && { groupId }),
    ...(categoryId && { categoryId }),
    ...(q && { q }),
    ...(status && { status }),
  };
  const active = Object.keys(filters).length;
  // Muda um filtro e volta à 1.ª página.
  const set = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };

  const choosePeriod = (key: PeriodKey) => {
    setPeriod(key);
    setPage(1);
    const p = PERIODS.find((x) => x.key === key);
    if (!p) return;
    setFrom(p.days === null ? '' : daysAgo(p.days));
    setTo(p.days === null ? '' : iso(new Date()));
  };
  const clearAll = () => {
    choosePeriod('all');
    setStatus(''); setDirection(''); setKind(''); setExtensionId(''); setGroupId(''); setCategoryId(''); setSearch('');
  };

  const { data, isLoading } = useQuery({
    queryKey: ['calls', page, filters],
    queryFn: () => callsApi.list({ page, ...filters }),
  });
  // Opções dos filtros (sem telefonia/tipificação as listas falham e o filtro some).
  const { data: extensions } = useQuery({ queryKey: ['telephony', 'extensions'], queryFn: telephonyApi.listExtensions, retry: false });
  const { data: groups } = useQuery({ queryKey: ['telephony', 'groups'], queryFn: telephonyApi.listGroups, retry: false });
  const { data: categories } = useQuery({ queryKey: ['call-categories'], queryFn: callTypingApi.categories, retry: false });
  const catName = (id: string | null) => categories?.find((c) => c.id === id)?.name;

  const exportXlsx = async () => {
    setExporting(true);
    try {
      saveBlob(await callsApi.exportXlsx(filters));
    } catch {
      toast.error(t('calls.exportError'));
    } finally {
      setExporting(false);
    }
  };

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
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[16rem] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('calls.searchPlaceholder')}
                className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm"
              />
            </div>
            <div className="inline-flex rounded-lg border border-gray-300 p-0.5">
              {PERIODS.map(({ key }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => choosePeriod(key)}
                  className={clsx('whitespace-nowrap rounded-md px-3 py-1.5 text-sm', period === key ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100')}
                >
                  {t(`calls.periods.${key}`)}
                </button>
              ))}
            </div>
            <input type="date" value={from} max={to || undefined} onChange={(e) => { setPeriod('custom'); set(setFrom)(e.target.value); }} className={selectCls} aria-label={t('reports.from')} />
            <input type="date" value={to} min={from || undefined} onChange={(e) => { setPeriod('custom'); set(setTo)(e.target.value); }} className={selectCls} aria-label={t('reports.to')} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <select value={direction} onChange={(e) => set(setDirection)(e.target.value as typeof direction)} className={selectCls}>
              <option value="">{t('calls.allDirections')}</option>
              <option value="inbound">{t('calls.inbound')}</option>
              <option value="outbound">{t('calls.outbound')}</option>
            </select>
            <select value={kind} onChange={(e) => set(setKind)(e.target.value as typeof kind)} className={selectCls}>
              <option value="">{t('calls.allKinds')}</option>
              {KINDS.map((k) => <option key={k} value={k}>{t(`calls.kinds.${k}`)}</option>)}
            </select>
            <select value={status} onChange={(e) => set(setStatus)(e.target.value as CallStatus | '')} className={selectCls}>
              <option value="">{t('calls.allStatuses')}</option>
              {STATUS_VALUES.map((v) => <option key={v} value={v}>{callStatusLabel(v)}</option>)}
            </select>
            {(extensions?.length ?? 0) > 0 && (
              <select value={extensionId} onChange={(e) => set(setExtensionId)(e.target.value)} className={selectCls}>
                <option value="">{t('calls.allAgents')}</option>
                {extensions!.map((x) => (
                  <option key={x.id} value={x.id}>{x.number}{x.displayName && x.displayName !== x.number ? ` — ${x.displayName}` : ''}</option>
                ))}
              </select>
            )}
            {(groups?.length ?? 0) > 0 && (
              <select value={groupId} onChange={(e) => set(setGroupId)(e.target.value)} className={selectCls}>
                <option value="">{t('calls.allGroups')}</option>
                {groups!.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            )}
            {(categories?.length ?? 0) > 0 && (
              <select value={categoryId} onChange={(e) => set(setCategoryId)(e.target.value)} className={selectCls}>
                <option value="">{t('calls.allTypings')}</option>
                {categories!.map((c) => (
                  <option key={c.id} value={c.id}>{c.parentId ? `${catName(c.parentId)} › ${c.name}` : c.name}</option>
                ))}
              </select>
            )}
            {active > 0 && (
              <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={clearAll}>
                {t('calls.clearFilters')}
              </Button>
            )}
            <div className="ml-auto flex items-center gap-3">
              {data && <p className="text-sm text-gray-500">{t('calls.count', { count: data.total })}</p>}
              <Button size="sm" variant="outline" icon={<FileSpreadsheet className="h-3.5 w-3.5" />} loading={exporting} onClick={() => void exportXlsx()}>
                {t('calls.exportExcel')}
              </Button>
            </div>
          </div>
        </Card>

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
