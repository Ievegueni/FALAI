import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Bot, Play, Pause, Send, Eye, Trash2, MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { agentsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageSpinner } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/contexts/ToastContext';
import { agentStatusLabel, agentStatusColor, formatDate } from '@/lib/utils';
import type { Agent, AgentStatus } from '@/types';

const STATUS_TABS = [
  { key: '', label: 'Todos' },
  { key: 'ACTIVE', label: 'Activos' },
  { key: 'DRAFT', label: 'Rascunhos' },
  { key: 'PENDING_REVIEW', label: 'Em revisão' },
  { key: 'PAUSED', label: 'Pausados' },
  { key: 'BLOCKED', label: 'Bloqueados' },
];

function AgentCard({ agent, onAction }: { agent: Agent; onAction: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { success, error } = useToast();

  const submitReview = useMutation({
    mutationFn: () => agentsApi.submitReview(agent.id),
    onSuccess: () => { success('Agente enviado para revisão'); void qc.invalidateQueries({ queryKey: ['agents'] }); onAction(); },
    onError: (e: Error) => error(e.message),
  });

  const pause = useMutation({
    mutationFn: () => agentsApi.pause(agent.id),
    onSuccess: () => { success('Agente pausado'); void qc.invalidateQueries({ queryKey: ['agents'] }); },
    onError: (e: Error) => error(e.message),
  });

  const resume = useMutation({
    mutationFn: () => agentsApi.resume(agent.id),
    onSuccess: () => { success('Agente retomado'); void qc.invalidateQueries({ queryKey: ['agents'] }); },
    onError: (e: Error) => error(e.message),
  });

  const del = useMutation({
    mutationFn: () => agentsApi.delete(agent.id),
    onSuccess: () => { success('Agente eliminado'); void qc.invalidateQueries({ queryKey: ['agents'] }); },
    onError: (e: Error) => error(e.message),
  });

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-900">{agent.name}</h3>
            <p className="text-xs text-gray-400 mt-0.5">v{agent.currentVersion} · {formatDate(agent.updatedAt)}</p>
          </div>
        </div>
        <Badge className={agentStatusColor[agent.status]}>
          {agentStatusLabel[agent.status]}
        </Badge>
      </div>

      {agent.status === 'BLOCKED' && agent.reviewRejectionReason && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          <strong>Bloqueado:</strong> {agent.reviewRejectionReason}
        </div>
      )}

      {agent.status === 'PENDING_REVIEW' && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
          Em verificação de qualidade. SLA: 4 horas úteis.
        </div>
      )}

      <div className="flex items-center gap-2 pt-1 border-t border-gray-100 flex-wrap">
        <Button size="sm" variant="ghost" icon={<Eye className="h-3.5 w-3.5" />} onClick={() => navigate(`/agents/${agent.id}`)}>
          Editar
        </Button>
        <Button size="sm" variant="ghost" icon={<MessageSquare className="h-3.5 w-3.5" />} onClick={() => navigate(`/agents/${agent.id}/simulate`)}>
          Simular
        </Button>

        {agent.status === 'DRAFT' && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Send className="h-3.5 w-3.5" />}
            loading={submitReview.isPending}
            onClick={() => submitReview.mutate()}
          >
            Submeter
          </Button>
        )}
        {agent.status === 'ACTIVE' && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Pause className="h-3.5 w-3.5" />}
            loading={pause.isPending}
            onClick={() => pause.mutate()}
          >
            Pausar
          </Button>
        )}
        {agent.status === 'PAUSED' && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Play className="h-3.5 w-3.5" />}
            loading={resume.isPending}
            onClick={() => resume.mutate()}
          >
            Retomar
          </Button>
        )}

        {(agent.status === 'DRAFT' || agent.status === 'BLOCKED') && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
            loading={del.isPending}
            onClick={() => {
              if (confirm(`Eliminar o agente "${agent.name}"?`)) del.mutate();
            }}
          >
            <span className="text-red-500">Eliminar</span>
          </Button>
        )}
      </div>
    </Card>
  );
}

export function AgentsPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['agents', tab, page],
    queryFn: () => agentsApi.list({ page, status: tab || undefined }),
  });

  return (
    <>
      <Header
        title="Agentes de IA"
        actions={
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate('/agents/new')}>
            Novo agente
          </Button>
        }
      />

      <div className="p-6 space-y-4">
        <Tabs
          tabs={STATUS_TABS}
          active={tab}
          onChange={(k) => { setTab(k); setPage(1); }}
        />

        {isLoading ? (
          <PageSpinner />
        ) : data?.data.length === 0 ? (
          <EmptyState
            icon={<Bot className="h-8 w-8" />}
            title="Sem agentes ainda"
            description="Crie o seu primeiro agente a partir de um template ou do zero."
            action={{ label: 'Criar agente', icon: <Plus className="h-4 w-4" />, onClick: () => navigate('/agents/new') }}
          />
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {data?.data.map((agent) => (
                <AgentCard key={agent.id} agent={agent} onAction={() => setPage(1)} />
              ))}
            </div>
            {data && (
              <Pagination page={page} total={data.total} perPage={data.perPage} onPage={setPage} />
            )}
          </>
        )}
      </div>
    </>
  );
}
