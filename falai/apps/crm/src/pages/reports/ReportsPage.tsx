import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { reportsApi, telephonyApi, callTypingApi, type AttendanceFilters } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import { AttendanceTab, type AttendanceView } from './AttendanceTabs';
import { SummaryTab } from './SummaryTab';
import { useToast } from '@/contexts/ToastContext';
import { clsx } from '@/lib/utils';

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

type Period = 'today' | '7d' | '30d' | '90d' | 'custom';
const PRESETS: { key: Exclude<Period, 'custom'>; days: number }[] = [
  { key: 'today', days: 0 },
  { key: '7d', days: 6 },
  { key: '30d', days: 29 },
  { key: '90d', days: 89 },
];

/** Últimos N dias, a contar com hoje. */
function periodRange(p: Exclude<Period, 'custom'>): { from: string; to: string } {
  const days = PRESETS.find((x) => x.key === p)!.days;
  return { from: isoDaysAgo(days), to: new Date().toISOString().slice(0, 10) };
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
  const [from, setFrom] = useState(isoDaysAgo(29));
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

  const exportPdf = async () => {
    setDownloading(true);
    try {
      saveBlob(await reportsApi.downloadOverviewPdf({ from, to }));
    } catch {
      toast.error(t('reports.exportError'));
    } finally {
      setDownloading(false);
    }
  };

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

  return (
    <div>
      <Header
        title={t('nav.reports')}
        actions={
          <>
            {tab === 'summary' && (
              <>
                <Button variant="outline" size="sm" icon={<Download className="h-4 w-4" />} onClick={exportCsv} disabled={downloading}>
                  {t('reports.exportCsv')}
                </Button>
                <Button size="sm" icon={<FileText className="h-4 w-4" />} onClick={() => void exportPdf()} loading={downloading}>
                  {t('reports.exportPdf')}
                </Button>
              </>
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
            <div className="inline-flex rounded-lg border border-gray-300 p-0.5">
              {PRESETS.map(({ key }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => choosePeriod(key)}
                  className={clsx(
                    'rounded-md px-3 py-1.5 text-sm transition-colors',
                    period === key ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100',
                  )}
                >
                  {t(`reports.periods.${key}`)}
                </button>
              ))}
            </div>
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

        {tab === 'summary' ? <SummaryTab from={from} to={to} /> : <AttendanceTab view={tab} filters={filters} />}
      </div>
    </div>
  );
}
