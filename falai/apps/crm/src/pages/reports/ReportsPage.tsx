import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Phone, PhoneIncoming, PhoneOutgoing, CheckCircle, PhoneMissed, Clock, MessageSquare, Download, Printer, FileSpreadsheet } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { reportsApi, telephonyApi, callTypingApi, type AttendanceFilters } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Card, StatCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import { AttendanceTab, type AttendanceView } from './AttendanceTabs';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import { formatDuration, formatAOA } from '@/lib/utils';

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

type Period = 'today' | 'week' | 'month' | '30d' | 'custom';

/** Intervalo de um atalho de período (semana começa à segunda). */
function periodRange(p: Exclude<Period, 'custom'>): { from: string; to: string } {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (p === 'today') return { from: iso(today), to: iso(today) };
  if (p === 'week') {
    const d = new Date(today);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return { from: iso(d), to: iso(today) };
  }
  if (p === 'month') return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1, 12)), to: iso(today) };
  return { from: isoDaysAgo(30), to: iso(today) };
}

type ReportTab = 'summary' | AttendanceView;
const EXPORTABLE: Partial<Record<ReportTab, 'agents' | 'groups' | 'reasons' | 'typing'>> = {
  agents: 'agents',
  groups: 'groups',
  reasons: 'reasons',
  typing: 'typing',
};

function saveBlob({ blob, filename }: { blob: Blob; filename: string }) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const [tab, setTab] = useState<ReportTab>('summary');
  const [period, setPeriod] = useState<Period>('30d');
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [extensionId, setExtensionId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [downloading, setDownloading] = useState(false);

  const choosePeriod = (p: Period) => {
    setPeriod(p);
    if (p !== 'custom') {
      const r = periodRange(p);
      setFrom(r.from);
      setTo(r.to);
    }
  };

  const filters: AttendanceFilters = {
    from,
    to,
    ...(extensionId && { extensionId }),
    ...(groupId && { groupId }),
    ...(categoryId && { categoryId }),
  };

  // Opções dos filtros. Sem a funcionalidade de telefonia estas listas falham
  // — os filtros ficam só com "Todos" em vez de partir a página.
  const { data: extensions } = useQuery({ queryKey: ['telephony', 'extensions'], queryFn: telephonyApi.listExtensions, retry: false });
  const { data: groups } = useQuery({ queryKey: ['telephony', 'groups'], queryFn: telephonyApi.listGroups, retry: false });
  const { data: categories } = useQuery({ queryKey: ['call-categories'], queryFn: callTypingApi.categories, retry: false });
  const catName = (id: string | null) => categories?.find((c) => c.id === id)?.name;

  const exportAttendance = async (format: 'csv' | 'xlsx') => {
    const view = EXPORTABLE[tab];
    if (!view) return;
    setDownloading(true);
    try {
      saveBlob(await reportsApi.downloadAttendance({ ...filters, view, format }));
    } catch {
      toast.error(t('reports.exportError'));
    } finally {
      setDownloading(false);
    }
  };

  const { data, isLoading } = useQuery({
    queryKey: ['reports', from, to],
    queryFn: () => reportsApi.summary({ from, to }),
    enabled: tab === 'summary',
  });

  const exportCsv = async () => {
    setDownloading(true);
    try {
      saveBlob(await reportsApi.downloadCsv({ from, to }));
    } catch {
      toast.error(t('reports.exportError'));
    } finally {
      setDownloading(false);
    }
  };

  const totals = data?.totals;
  const chartData =
    data?.byDay.map((d) => ({
      date: d.date.slice(5), // MM-DD
      [t('reports.answered')]: d.answered,
      [t('reports.total')]: d.total,
    })) ?? [];

  return (
    <div>
      <Header
        title={t('nav.reports')}
        actions={
          <>
            <Button variant="outline" size="sm" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>
              {t('reports.pdf')}
            </Button>
            {tab === 'summary' && (
              <Button size="sm" icon={<Download className="h-4 w-4" />} onClick={exportCsv} disabled={downloading}>
                {t('reports.exportCsv')}
              </Button>
            )}
            {EXPORTABLE[tab] && (
              <>
                <Button variant="outline" size="sm" icon={<Download className="h-4 w-4" />} onClick={() => void exportAttendance('csv')} disabled={downloading}>
                  CSV
                </Button>
                <Button size="sm" icon={<FileSpreadsheet className="h-4 w-4" />} onClick={() => void exportAttendance('xlsx')} disabled={downloading}>
                  Excel
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="p-6 space-y-6">
        <Tabs
          active={tab}
          onChange={(k) => setTab(k as ReportTab)}
          tabs={[
            { key: 'summary', label: t('reports.tabs.summary') },
            { key: 'attendance', label: t('reports.tabs.attendance') },
            { key: 'agents', label: t('reports.tabs.agents') },
            { key: 'groups', label: t('reports.tabs.groups') },
            { key: 'reasons', label: t('reports.tabs.reasons') },
            { key: 'typing', label: t('reports.tabs.typing') },
            { key: 'calls', label: t('reports.tabs.calls') },
          ]}
        />

        {/* Filtros comuns a todos os separadores */}
        <Card className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">{t('reports.period')}</label>
            <select
              value={period}
              onChange={(e) => choosePeriod(e.target.value as Period)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {(['today', 'week', 'month', '30d', 'custom'] as const).map((p) => (
                <option key={p} value={p}>{t(`reports.periods.${p}`)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">{t('reports.from')}</label>
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => { setPeriod('custom'); setFrom(e.target.value); }}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">{t('reports.to')}</label>
            <input
              type="date"
              value={to}
              min={from}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => { setPeriod('custom'); setTo(e.target.value); }}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          {tab !== 'summary' && (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('reports.att.agent')}</label>
                <select value={extensionId} onChange={(e) => setExtensionId(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  <option value="">{t('reports.all')}</option>
                  {extensions?.map((x) => (
                    <option key={x.id} value={x.id}>{x.number}{x.displayName && x.displayName !== x.number ? ` — ${x.displayName}` : ''}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('reports.att.group')}</label>
                <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  <option value="">{t('reports.all')}</option>
                  {groups?.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>
              {(categories?.length ?? 0) > 0 && (
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">{t('reports.att.category')}</label>
                  <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
                    <option value="">{t('reports.all')}</option>
                    {categories!.map((c) => (
                      <option key={c.id} value={c.id}>{c.parentId ? `${catName(c.parentId)} › ${c.name}` : c.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}
        </Card>

        {tab !== 'summary' ? (
          <AttendanceTab view={tab} filters={filters} />
        ) : isLoading || !totals ? (
          <PageSpinner />
        ) : (
          <>
            {/* Cartões de resumo */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
              <StatCard label={t('reports.total')} value={totals.total} icon={<Phone className="h-5 w-5" />} />
              <StatCard label={t('reports.inbound')} value={totals.inbound} icon={<PhoneIncoming className="h-5 w-5" />} />
              <StatCard label={t('reports.outbound')} value={totals.outbound} icon={<PhoneOutgoing className="h-5 w-5" />} />
              <StatCard label={t('reports.answered')} value={totals.answered} icon={<CheckCircle className="h-5 w-5" />} />
              <StatCard label={t('reports.missed')} value={totals.missed} icon={<PhoneMissed className="h-5 w-5" />} />
              <StatCard
                label={t('reports.avgDuration')}
                value={formatDuration(totals.avgDurationSecs)}
                icon={<Clock className="h-5 w-5" />}
              />
            </div>

            {/* Consumo de SMS */}
            {data.sms.total > 0 && (
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <StatCard label={t('reports.smsSent')} value={data.sms.sent} icon={<MessageSquare className="h-5 w-5" />} />
                <StatCard label={t('reports.smsFailed')} value={data.sms.failed} icon={<MessageSquare className="h-5 w-5" />} />
                <StatCard label={t('reports.smsCost')} value={formatAOA(data.sms.costCents)} icon={<MessageSquare className="h-5 w-5" />} />
              </div>
            )}

            {/* Gráfico por dia */}
            <Card>
              <h2 className="mb-4 text-sm font-semibold text-gray-900">{t('reports.byDay')}</h2>
              {chartData.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-400">{t('reports.noData')}</p>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="date" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey={t('reports.total')} fill="#93c5fd" radius={[4, 4, 0, 0]} />
                    <Bar dataKey={t('reports.answered')} fill="#34d399" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Card>

            {/* Repartição por resultado */}
            <Card>
              <h2 className="mb-4 text-sm font-semibold text-gray-900">{t('reports.byOutcome')}</h2>
              {data.byOutcome.length === 0 ? (
                <p className="py-4 text-center text-sm text-gray-400">{t('reports.noData')}</p>
              ) : (
                <div className="space-y-2">
                  {data.byOutcome.map((o) => {
                    const pct = totals.total > 0 ? (o.count / totals.total) * 100 : 0;
                    return (
                      <div key={o.outcome} className="flex items-center gap-3">
                        <span className="w-40 shrink-0 truncate text-sm text-gray-600">{o.outcome}</span>
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                          <div className="h-full rounded-full bg-blue-400" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="w-10 shrink-0 text-right text-sm font-medium text-gray-700">{o.count}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
