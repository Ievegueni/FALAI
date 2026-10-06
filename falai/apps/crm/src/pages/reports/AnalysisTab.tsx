import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Sparkles, AlertTriangle, AlertOctagon, Info, TrendingUp, TrendingDown, Lightbulb, Users, Tag } from 'lucide-react';
import { reportsApi, type ReportAnalysisState } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';

/**
 * Separador "Análise IA" (melhoria 6): a análise do Claude ao resumo dos
 * filtros activos. É gerada pelo botão "Analisar com IA" e vai também nas
 * exportações (Excel/PDF) destes filtros.
 */

const SEVERITY = {
  critical: { icon: AlertOctagon, cls: 'border-red-200 bg-red-50 text-red-800' },
  warning: { icon: AlertTriangle, cls: 'border-amber-200 bg-amber-50 text-amber-900' },
  info: { icon: Info, cls: 'border-blue-200 bg-blue-50 text-blue-900' },
} as const;

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <Card>
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">{icon}{title}</h3>
      {children}
    </Card>
  );
}

function People({ title, items, tone }: { title: string; items: { who: string; why: string }[]; tone: 'up' | 'down' }) {
  const { t } = useTranslation();
  const Icon = tone === 'up' ? TrendingUp : TrendingDown;
  return (
    <div>
      <p className={`mb-2 flex items-center gap-1.5 text-xs font-medium ${tone === 'up' ? 'text-emerald-700' : 'text-red-600'}`}>
        <Icon className="h-3.5 w-3.5" />{title}
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-gray-400">{t('reports.ai.none')}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((p, i) => (
            <li key={i} className="text-sm"><span className="font-medium text-gray-900">{p.who}</span> <span className="text-gray-600">— {p.why}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AnalysisTab({ state, analyzing, onAnalyze }: { state: ReportAnalysisState | undefined; analyzing: boolean; onAnalyze: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const toggleNames = useMutation({
    mutationFn: (v: boolean) => reportsApi.analysisSettings(v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reports', 'analysis'] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const a = state?.analysis;
  const r = a?.result;

  return (
    <div className="space-y-4">
      {/* Barra: uso do dia, opção dos nomes, aviso */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-500">
        {state && <span>{t('reports.ai.usage', { used: state.usedToday, limit: state.dailyLimit })}</span>}
        {state?.canConfigure && (
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={state.agentNames} disabled={toggleNames.isPending} onChange={(e) => toggleNames.mutate(e.target.checked)} />
            {t('reports.ai.agentNames')}
          </label>
        )}
        <span className="ml-auto">{t('reports.ai.privacy')}</span>
      </div>

      {!r ? (
        <Card className="py-12 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-blue-600" />
          <p className="mt-3 text-sm font-medium text-gray-900">{t('reports.ai.emptyTitle')}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">{t('reports.ai.emptyText')}</p>
          {state?.canAnalyze ? (
            <Button className="mt-4" icon={<Sparkles className="h-4 w-4" />} loading={analyzing} onClick={onAnalyze}>{t('reports.ai.analyze')}</Button>
          ) : (
            <p className="mt-4 text-xs text-gray-400">{t('reports.ai.noPermission')}</p>
          )}
        </Card>
      ) : (
        <>
          <Card className="border-blue-200 bg-blue-50/50">
            <p className="flex items-start gap-2 text-base font-semibold text-gray-900"><Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />{r.headline}</p>
            <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-gray-700">{r.summary}</p>
            {r.comparison && (
              <p className="mt-3 border-t border-blue-100 pt-3 text-sm text-gray-700"><span className="font-medium text-gray-900">{t('reports.ai.comparison')}: </span>{r.comparison}</p>
            )}
            <p className="mt-3 text-xs text-gray-400">
              {t('reports.ai.generatedAt', { date: new Date(a.createdAt).toLocaleString('pt-PT') })}
              {a.model === 'stub' && ` · ${t('reports.ai.stub')}`}
            </p>
          </Card>

          {r.anomalies.length > 0 && (
            <Section icon={<AlertTriangle className="h-4 w-4 text-amber-600" />} title={t('reports.ai.anomalies')}>
              <ul className="space-y-2">
                {r.anomalies.map((x, i) => {
                  const S = SEVERITY[x.severity];
                  return (
                    <li key={i} className={`flex gap-2 rounded-lg border p-3 text-sm ${S.cls}`}>
                      <S.icon className="mt-0.5 h-4 w-4 shrink-0" />
                      <div><p className="font-medium">{x.title}</p><p className="opacity-90">{x.detail}</p></div>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Section icon={<Users className="h-4 w-4 text-gray-500" />} title={t('reports.ai.agents')}>
              <div className="grid gap-4 sm:grid-cols-2">
                <People title={t('reports.ai.above')} items={r.agents.above} tone="up" />
                <People title={t('reports.ai.below')} items={r.agents.below} tone="down" />
              </div>
            </Section>
            <Section icon={<Users className="h-4 w-4 text-gray-500" />} title={t('reports.ai.groups')}>
              <div className="grid gap-4 sm:grid-cols-2">
                <People title={t('reports.ai.above')} items={r.groups.above} tone="up" />
                <People title={t('reports.ai.below')} items={r.groups.below} tone="down" />
              </div>
            </Section>
          </div>

          {r.typingTrends.length > 0 && (
            <Section icon={<Tag className="h-4 w-4 text-gray-500" />} title={t('reports.ai.typingTrends')}>
              <ul className="space-y-1.5">
                {r.typingTrends.map((x, i) => (
                  <li key={i} className="text-sm"><span className="font-medium text-gray-900">{x.label}</span> <span className="text-gray-600">— {x.detail}</span></li>
                ))}
              </ul>
            </Section>
          )}

          <Section icon={<Lightbulb className="h-4 w-4 text-emerald-600" />} title={t('reports.ai.recommendations')}>
            <ol className="space-y-3">
              {r.recommendations.map((x, i) => (
                <li key={i} className="flex gap-3 text-sm">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-xs font-semibold text-emerald-700">{i + 1}</span>
                  <div><p className="font-medium text-gray-900">{x.title}</p><p className="text-gray-600">{x.detail}</p></div>
                </li>
              ))}
            </ol>
          </Section>
          <p className="text-xs text-gray-400">{t('reports.ai.disclaimer')}</p>
        </>
      )}
    </div>
  );
}
