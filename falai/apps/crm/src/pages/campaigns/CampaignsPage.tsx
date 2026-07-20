import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Megaphone, Play, Pause, Square, BarChart2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { campaignsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageSpinner } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { useToast } from '@/contexts/ToastContext';
import { campaignStatusLabel, campaignStatusColor, formatDate, formatAOA } from '@/lib/utils';
import type { Campaign } from '@/types';

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-gray-200 rounded-full h-1.5">
        <div className="bg-blue-600 h-1.5 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 w-8 text-right">{pct}%</span>
    </div>
  );
}

function CampaignCard({ c }: { c: Campaign }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { success, error } = useToast();

  function action(fn: () => Promise<Campaign>, msg: string) {
    return useMutation({
      mutationFn: fn,
      onSuccess: () => { success(msg); void qc.invalidateQueries({ queryKey: ['campaigns'] }); },
      onError: (e: Error) => error(e.message),
    });
  }

  const start = action(() => campaignsApi.start(c.id), 'Campanha iniciada');
  const pause = action(() => campaignsApi.pause(c.id), 'Campanha pausada');
  const resume = action(() => campaignsApi.resume(c.id), 'Campanha retomada');
  const cancel = action(() => campaignsApi.cancel(c.id), 'Campanha cancelada');

  const answered = c.answeredCount;
  const answerRate = c.completedCount > 0 ? Math.round((answered / c.completedCount) * 100) : 0;

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{c.name}</h3>
          <p className="text-xs text-gray-500 mt-0.5">{c.agent.name} · {formatDate(c.createdAt)}</p>
        </div>
        <Badge className={campaignStatusColor[c.status]}>{campaignStatusLabel(c.status)}</Badge>
      </div>

      <div className="grid grid-cols-4 gap-2 text-center">
        <div>
          <p className="text-lg font-bold text-gray-900">{c.totalContacts}</p>
          <p className="text-xs text-gray-400">Total</p>
        </div>
        <div>
          <p className="text-lg font-bold text-emerald-600">{c.completedCount}</p>
          <p className="text-xs text-gray-400">Concluídas</p>
        </div>
        <div>
          <p className="text-lg font-bold text-blue-600">{answerRate}%</p>
          <p className="text-xs text-gray-400">Atendimento</p>
        </div>
        <div>
          <p className="text-lg font-bold text-gray-700">{formatAOA(c.actualCostCents)}</p>
          <p className="text-xs text-gray-400">Custo</p>
        </div>
      </div>

      <ProgressBar value={c.completedCount + c.failedCount} max={c.totalContacts} />

      <div className="flex items-center gap-2 pt-1 border-t border-gray-100 flex-wrap">
        <Button size="sm" variant="ghost" icon={<BarChart2 className="h-3.5 w-3.5" />} onClick={() => navigate(`/campaigns/${c.id}`)}>
          Relatório
        </Button>

        {c.status === 'DRAFT' && (
          <Button size="sm" variant="ghost" icon={<Play className="h-3.5 w-3.5" />} loading={start.isPending} onClick={() => start.mutate()}>
            Iniciar
          </Button>
        )}
        {c.status === 'ACTIVE' && (
          <Button size="sm" variant="ghost" icon={<Pause className="h-3.5 w-3.5" />} loading={pause.isPending} onClick={() => pause.mutate()}>
            Pausar
          </Button>
        )}
        {c.status === 'PAUSED' && (
          <Button size="sm" variant="ghost" icon={<Play className="h-3.5 w-3.5" />} loading={resume.isPending} onClick={() => resume.mutate()}>
            Retomar
          </Button>
        )}
        {['DRAFT', 'ACTIVE', 'PAUSED'].includes(c.status) && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Square className="h-3.5 w-3.5 text-red-500" />}
            loading={cancel.isPending}
            onClick={() => { if (confirm('Cancelar esta campanha?')) cancel.mutate(); }}
          >
            <span className="text-red-500">Cancelar</span>
          </Button>
        )}
      </div>
    </Card>
  );
}

export function CampaignsPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['campaigns', page],
    queryFn: () => campaignsApi.list({ page }),
    refetchInterval: 15_000,
  });

  return (
    <>
      <Header
        title="Campanhas"
        actions={
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate('/campaigns/new')}>
            Nova campanha
          </Button>
        }
      />

      <div className="p-6 space-y-4">
        {isLoading ? (
          <PageSpinner />
        ) : data?.data.length === 0 ? (
          <EmptyState
            icon={<Megaphone className="h-8 w-8" />}
            title="Sem campanhas"
            description="Crie a sua primeira campanha para contactar múltiplos clientes automaticamente."
            action={{ label: 'Nova campanha', icon: <Plus className="h-4 w-4" />, onClick: () => navigate('/campaigns/new') }}
          />
        ) : (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {data?.data.map((c) => <CampaignCard key={c.id} c={c} />)}
            </div>
            {data && <Pagination page={page} total={data.total} perPage={data.perPage} onPage={setPage} />}
          </>
        )}
      </div>
    </>
  );
}
