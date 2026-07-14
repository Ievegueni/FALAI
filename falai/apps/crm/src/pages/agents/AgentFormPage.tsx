import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Save, MessageSquare, Info } from 'lucide-react';
import { agentsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, Select } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';

const TEMPLATES = [
  {
    id: 'cobranca',
    label: 'Cobrança amigável',
    objective: 'Contactar clientes com dívidas em atraso e negociar um plano de pagamento.',
    tone: 'Profissional, empático e respeitoso. Nunca agressivo.',
    dataToCollect: 'Confirmação de recebimento, data prevista de pagamento, valor que consegue pagar.',
    neverSay: 'Ameaças legais, valores de juros não acordados, informações de outros clientes.',
  },
  {
    id: 'confirmacao',
    label: 'Confirmação de entrega',
    objective: 'Confirmar que o cliente recebeu o seu pedido e recolher feedback.',
    tone: 'Cordial e eficiente.',
    dataToCollect: 'Se recebeu, condição da entrega, satisfação de 1 a 5.',
    neverSay: 'Informações de outros pedidos ou clientes.',
  },
  {
    id: 'pesquisa',
    label: 'Pesquisa de satisfação',
    objective: 'Recolher feedback sobre o serviço prestado nos últimos 30 dias.',
    tone: 'Amigável e breve. Máximo 3 minutos.',
    dataToCollect: 'NPS (0-10), razão principal, o que pode melhorar.',
    neverSay: 'Perguntas sobre concorrentes pelo nome.',
  },
];

interface FormData {
  name: string;
  objective: string;
  tone: string;
  dataToCollect: string;
  neverSay: string;
  maxDurationSecs: number;
  escalationPhone: string;
}

const EMPTY: FormData = {
  name: '',
  objective: '',
  tone: 'Profissional e empático.',
  dataToCollect: '',
  neverSay: '',
  maxDurationSecs: 180,
  escalationPhone: '',
};

export function AgentFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { success, error: toastError } = useToast();

  const [form, setForm] = useState<FormData>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof FormData, string>>>({});

  const { data: agent, isLoading } = useQuery({
    queryKey: ['agents', id],
    queryFn: () => agentsApi.get(id!),
    enabled: isEdit,
  });

  useEffect(() => {
    if (!agent) return;
    setForm({
      name: agent.name,
      objective: '',
      tone: '',
      dataToCollect: '',
      neverSay: '',
      maxDurationSecs: agent.maxDurationSecs,
      escalationPhone: agent.escalationPhone ?? '',
    });
  }, [agent]);

  function set<K extends keyof FormData>(k: K, v: FormData[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  }

  function applyTemplate(id: string) {
    const t = TEMPLATES.find((t) => t.id === id);
    if (!t) return;
    setForm((f) => ({
      ...f,
      objective: t.objective,
      tone: t.tone,
      dataToCollect: t.dataToCollect,
      neverSay: t.neverSay,
    }));
  }

  function validate(): boolean {
    const e: Partial<Record<keyof FormData, string>> = {};
    if (!form.name.trim()) e.name = 'Nome obrigatório';
    if (!form.objective.trim()) e.objective = 'Objectivo obrigatório';
    if (!form.tone.trim()) e.tone = 'Tom obrigatório';
    if (form.maxDurationSecs < 30) e.maxDurationSecs = 'Mínimo 30 segundos';
    if (form.maxDurationSecs > 1800) e.maxDurationSecs = 'Máximo 30 minutos';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const save = useMutation({
    mutationFn: () => {
      const data = {
        name: form.name,
        objective: form.objective,
        tone: form.tone,
        dataToCollect: form.dataToCollect,
        neverSay: form.neverSay,
        maxDurationSecs: form.maxDurationSecs,
        ...(form.escalationPhone ? { escalationPhone: form.escalationPhone } : {}),
      };
      return isEdit ? agentsApi.update(id!, data) : agentsApi.create(data);
    },
    onSuccess: (saved) => {
      success(isEdit ? 'Agente actualizado' : 'Agente criado');
      void qc.invalidateQueries({ queryKey: ['agents'] });
      navigate(`/agents/${saved.id}`);
    },
    onError: (e: Error) => toastError(e.message),
  });

  if (isEdit && isLoading) return <><Header title="Agente" /><PageSpinner /></>;

  return (
    <>
      <Header
        title={isEdit ? 'Editar agente' : 'Novo agente'}
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={<ArrowLeft className="h-3.5 w-3.5" />}
            onClick={() => navigate('/agents')}
          >
            Voltar
          </Button>
        }
      />

      <div className="p-6 max-w-3xl space-y-6">
        {!isEdit && (
          <Card>
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Começar de um template</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => applyTemplate(t.id)}
                  className="rounded-lg border border-gray-200 p-3 text-left hover:border-blue-400 hover:bg-blue-50 transition-colors"
                >
                  <p className="text-sm font-medium text-gray-900">{t.label}</p>
                </button>
              ))}
            </div>
          </Card>
        )}

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Informações do agente</h2>
          <div className="flex flex-col gap-4">
            <Input
              label="Nome do agente"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              error={errors.name}
              placeholder="ex: Agente de Cobrança"
              required
            />

            <Textarea
              label="Objectivo"
              value={form.objective}
              onChange={(e) => set('objective', e.target.value)}
              error={errors.objective}
              placeholder="Qual é o objectivo desta conversa? Seja específico sobre o resultado pretendido."
              rows={3}
              required
            />

            <Textarea
              label="Tom e personalidade"
              value={form.tone}
              onChange={(e) => set('tone', e.target.value)}
              error={errors.tone}
              placeholder="Como deve o agente comunicar? ex: Profissional, empático, directo."
              rows={2}
              required
            />

            <Textarea
              label="Informação a recolher"
              value={form.dataToCollect}
              onChange={(e) => set('dataToCollect', e.target.value)}
              error={errors.dataToCollect}
              placeholder="Que dados deve o agente recolher durante a chamada?"
              rows={3}
            />

            <Textarea
              label="O que nunca dizer"
              value={form.neverSay}
              onChange={(e) => set('neverSay', e.target.value)}
              error={errors.neverSay}
              placeholder="Tópicos, frases ou informações que o agente nunca deve mencionar."
              rows={2}
            />
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Regras da chamada</h2>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Duração máxima (segundos)"
              type="number"
              value={form.maxDurationSecs}
              onChange={(e) => set('maxDurationSecs', parseInt(e.target.value, 10))}
              error={errors.maxDurationSecs}
              min={30}
              max={1800}
              hint="Mínimo 30s, máximo 30 min (1800s)"
            />
            <Input
              label="Número de escalonamento"
              value={form.escalationPhone}
              onChange={(e) => set('escalationPhone', e.target.value)}
              error={errors.escalationPhone}
              placeholder="+244 9XX XXX XXX"
              hint="Transfere a chamada se o cliente pedir um humano"
            />
          </div>
        </Card>

        <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 flex gap-3">
          <Info className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-blue-700">
            Após guardar, pode usar o <strong>Simulador</strong> para testar o agente em texto antes de activar.
            A submissão para revisão é feita separadamente na listagem de agentes.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            icon={<Save className="h-4 w-4" />}
            loading={save.isPending}
            onClick={() => { if (validate()) save.mutate(); }}
          >
            {isEdit ? 'Guardar alterações' : 'Criar agente'}
          </Button>
          {id && (
            <Button
              variant="outline"
              icon={<MessageSquare className="h-4 w-4" />}
              onClick={() => navigate(`/agents/${id}/simulate`)}
            >
              Abrir simulador
            </Button>
          )}
          <Button variant="ghost" onClick={() => navigate('/agents')}>
            Cancelar
          </Button>
        </div>
      </div>
    </>
  );
}
