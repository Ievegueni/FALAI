import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { agentTimeApi, type AgentTimeRow } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { PageSpinner } from '@/components/ui/Spinner';
import { formatDate, formatDuration, formatPhone } from '@/lib/utils';

/** Escalado, ligado, aderência ao turno, pausas, conversa e pós-chamada (fase 5). Âmbito pela API. */
export function AgentTimeTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const [agent, setAgent] = useState<AgentTimeRow | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['reports', 'agent-time', from, to], queryFn: () => agentTimeApi.report({ from, to }) });
  if (isLoading || !data) return <PageSpinner />;
  const dur = (s: number) => (s ? formatDuration(s) : '—');
  const cols = ['agent', 'scheduled', 'logged', 'inShift', 'adherence', 'available', 'talk', 'wrapUp', 'paused', 'pauses'];
  return (
    <Card padding={false} className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs text-gray-500">
          <tr>
            {cols.map((k) => (
              <th key={k} className="px-4 py-2.5 font-medium">{t(`reports.agentTime.${k}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {data.data.map((r) => (
            <tr key={r.userId} onClick={() => setAgent(r)} className="cursor-pointer hover:bg-gray-50">
              <td className="px-4 py-2.5 font-medium text-gray-900">{r.name}</td>
              <td className="px-4 py-2.5 text-gray-700">{dur(r.scheduledSecs)}</td>
              <td className="px-4 py-2.5 text-gray-700">{dur(r.loggedSecs)}</td>
              <td className="px-4 py-2.5 text-gray-700">{dur(r.loggedInShiftSecs)}</td>
              <td className="px-4 py-2.5 text-gray-700">{r.adherencePct === null ? '—' : `${r.adherencePct}%`}</td>
              <td className="px-4 py-2.5 text-gray-700">{dur(r.availableSecs)}</td>
              <td className="px-4 py-2.5 text-gray-700">{dur(r.talkSecs)}</td>
              <td className="px-4 py-2.5 text-gray-700">{dur(r.wrapUpSecs)}</td>
              <td className="px-4 py-2.5 text-gray-700">{dur(r.pausedSecs)}</td>
              <td className="px-4 py-2.5 text-xs text-gray-600">
                {r.pauses.map((p) => `${p.reason ?? t('reports.agentTime.noReason')} ${formatDuration(p.secs)} (${p.count})`).join(' · ') || '—'}
              </td>
            </tr>
          ))}
          {data.data.length === 0 && (
            <tr><td colSpan={cols.length} className="px-4 py-8 text-center text-gray-400">{t('reports.agentTime.empty')}</td></tr>
          )}
        </tbody>
      </table>
      <p className="px-4 py-3 text-xs text-gray-500">{t('reports.agentTime.hint')} {t('reports.agentTime.timelineHint')}</p>
      {agent && <StatesModal agent={agent} from={from} to={to} onClose={() => setAgent(null)} />}
    </Card>
  );
}

const STATE_COLOR: Record<string, string> = {
  LOGGED_IN: 'bg-green-100 text-green-800',
  LOGGED_OUT: 'bg-gray-100 text-gray-600',
  PAUSED: 'bg-amber-100 text-amber-800',
  IN_CALL: 'bg-blue-100 text-blue-800',
  WRAP_UP: 'bg-purple-100 text-purple-800',
};

/** Linha do tempo dos estados (ligado, pausa com motivo, chamada, pós-chamada, desligado). */
function StatesModal({ agent, from, to, onClose }: { agent: AgentTimeRow; from: string; to: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'agent-states', agent.userId, from, to],
    queryFn: () => agentTimeApi.states({ userId: agent.userId, from, to }),
  });
  const secs = (a: string, b: string | null) => Math.round(((b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime()) / 1000);
  return (
    <Modal open onClose={onClose} size="xl" title={t('reports.agentTime.timeline', { name: agent.name })}>
      {isLoading || !data ? (
        <PageSpinner />
      ) : data.data.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-400">{t('reports.agentTime.noStates')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-gray-500">
            <tr>
              {['state', 'since', 'until', 'duration', 'detail'].map((k) => (
                <th key={k} className="py-2 pr-4 font-medium">{t(`reports.agentTime.${k}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {data.data.map((s, i) => (
              <tr key={i}>
                <td className="py-2 pr-4">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATE_COLOR[s.state] ?? ''}`}>{t(`reports.agentTime.states.${s.state}`)}</span>
                </td>
                <td className="py-2 pr-4 text-gray-700">{formatDate(s.from)}</td>
                <td className="py-2 pr-4 text-gray-700">{s.to ? formatDate(s.to) : t('reports.agentTime.ongoing')}</td>
                <td className="py-2 pr-4 text-gray-700">{formatDuration(secs(s.from, s.to))}</td>
                <td className="py-2 pr-4 text-gray-600">{s.detail && (s.state === 'IN_CALL' || s.state === 'WRAP_UP') && /\d{6}/.test(s.detail) ? formatPhone(s.detail) : (s.detail ?? '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
