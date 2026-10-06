import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { agentTimeApi } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { formatDuration } from '@/lib/utils';

/** Escalado, ligado, aderência ao turno e pausas por motivo (fase 5). Âmbito pela API. */
export function AgentTimeTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({ queryKey: ['reports', 'agent-time', from, to], queryFn: () => agentTimeApi.report({ from, to }) });
  if (isLoading || !data) return <PageSpinner />;
  const dur = (s: number) => (s ? formatDuration(s) : '—');
  return (
    <Card padding={false} className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs text-gray-500">
          <tr>
            {['agent', 'scheduled', 'logged', 'inShift', 'adherence', 'paused', 'pauses'].map((k) => (
              <th key={k} className="px-4 py-2.5 font-medium">{t(`reports.agentTime.${k}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {data.data.map((r) => (
            <tr key={r.userId}>
              <td className="px-4 py-2.5 font-medium text-gray-900">{r.name}</td>
              <td className="px-4 py-2.5 text-gray-700">{dur(r.scheduledSecs)}</td>
              <td className="px-4 py-2.5 text-gray-700">{dur(r.loggedSecs)}</td>
              <td className="px-4 py-2.5 text-gray-700">{dur(r.loggedInShiftSecs)}</td>
              <td className="px-4 py-2.5 text-gray-700">{r.adherencePct === null ? '—' : `${r.adherencePct}%`}</td>
              <td className="px-4 py-2.5 text-gray-700">{dur(r.pausedSecs)}</td>
              <td className="px-4 py-2.5 text-xs text-gray-600">
                {r.pauses.map((p) => `${p.reason ?? t('reports.agentTime.noReason')} ${formatDuration(p.secs)} (${p.count})`).join(' · ') || '—'}
              </td>
            </tr>
          ))}
          {data.data.length === 0 && (
            <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">{t('reports.agentTime.empty')}</td></tr>
          )}
        </tbody>
      </table>
      <p className="px-4 py-3 text-xs text-gray-500">{t('reports.agentTime.hint')}</p>
    </Card>
  );
}
