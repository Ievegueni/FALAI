import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation, Trans } from 'react-i18next';
import { ArrowLeft, Save, MessageSquare, Info } from 'lucide-react';
import { agentsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, Select } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';

// Conteúdo operacional em PT (prompt do agente); o label visível vem das traduções.
const TEMPLATES = [
  {
    id: 'cobranca',
    objective: 'Contactar clientes com dívidas em atraso e negociar um plano de pagamento.',
    tone: 'Profissional, empático e respeitoso. Nunca agressivo.',
    dataToCollect: 'Confirmação de recebimento, data prevista de pagamento, valor que consegue pagar.',
    neverSay: 'Ameaças legais, valores de juros não acordados, informações de outros clientes.',
  },
  {
    id: 'confirmacao',
    objective: 'Confirmar que o cliente recebeu o seu pedido e recolher feedback.',
    tone: 'Cordial e eficiente.',
    dataToCollect: 'Se recebeu, condição da entrega, satisfação de 1 a 5.',
    neverSay: 'Informações de outros pedidos ou clientes.',
  },
  {
    id: 'pesquisa',
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
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { success, error: toastError } = useToast();

  const templateLabel = (tid: string) => t(`onboarding.templates.${tid}.label`);

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

  function applyTemplate(tid: string) {
    const tpl = TEMPLATES.find((x) => x.id === tid);
    if (!tpl) return;
    setForm((f) => ({
      ...f,
      objective: tpl.objective,
      tone: tpl.tone,
      dataToCollect: tpl.dataToCollect,
      neverSay: tpl.neverSay,
    }));
  }

  function validate(): boolean {
    const e: Partial<Record<keyof FormData, string>> = {};
    if (!form.name.trim()) e.name = t('agentForm.errNameRequired');
    if (!form.objective.trim()) e.objective = t('agentForm.errObjectiveRequired');
    if (!form.tone.trim()) e.tone = t('agentForm.errToneRequired');
    if (form.maxDurationSecs < 30) e.maxDurationSecs = t('agentForm.errMinDuration');
    if (form.maxDurationSecs > 1800) e.maxDurationSecs = t('agentForm.errMaxDuration');
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
      success(isEdit ? t('agentForm.updated') : t('agentForm.created'));
      void qc.invalidateQueries({ queryKey: ['agents'] });
      navigate(`/agents/${saved.id}`);
    },
    onError: (e: Error) => toastError(e.message),
  });

  if (isEdit && isLoading) return <><Header title={t('agentForm.agentTitle')} /><PageSpinner /></>;

  return (
    <>
      <Header
        title={isEdit ? t('agentForm.titleEdit') : t('agentForm.titleNew')}
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={<ArrowLeft className="h-3.5 w-3.5" />}
            onClick={() => navigate('/agents')}
          >
            {t('common.back')}
          </Button>
        }
      />

      <div className="p-6 max-w-3xl space-y-6">
        {!isEdit && (
          <Card>
            <h2 className="text-sm font-semibold text-gray-900 mb-3">{t('agentForm.startFromTemplate')}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  onClick={() => applyTemplate(tpl.id)}
                  className="rounded-lg border border-gray-200 p-3 text-left hover:border-blue-400 hover:bg-blue-50 transition-colors"
                >
                  <p className="text-sm font-medium text-gray-900">{templateLabel(tpl.id)}</p>
                </button>
              ))}
            </div>
          </Card>
        )}

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('agentForm.agentInfo')}</h2>
          <div className="flex flex-col gap-4">
            <Input
              label={t('agentForm.name')}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              error={errors.name}
              placeholder={t('agentForm.namePlaceholder')}
              required
            />

            <Textarea
              label={t('agentForm.objective')}
              value={form.objective}
              onChange={(e) => set('objective', e.target.value)}
              error={errors.objective}
              placeholder={t('agentForm.objectivePlaceholder')}
              rows={3}
              required
            />

            <Textarea
              label={t('agentForm.tone')}
              value={form.tone}
              onChange={(e) => set('tone', e.target.value)}
              error={errors.tone}
              placeholder={t('agentForm.tonePlaceholder')}
              rows={2}
              required
            />

            <Textarea
              label={t('agentForm.dataToCollect')}
              value={form.dataToCollect}
              onChange={(e) => set('dataToCollect', e.target.value)}
              error={errors.dataToCollect}
              placeholder={t('agentForm.dataToCollectPlaceholder')}
              rows={3}
            />

            <Textarea
              label={t('agentForm.neverSay')}
              value={form.neverSay}
              onChange={(e) => set('neverSay', e.target.value)}
              error={errors.neverSay}
              placeholder={t('agentForm.neverSayPlaceholder')}
              rows={2}
            />
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('agentForm.callRules')}</h2>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label={t('agentForm.maxDuration')}
              type="number"
              value={form.maxDurationSecs}
              onChange={(e) => set('maxDurationSecs', parseInt(e.target.value, 10))}
              error={errors.maxDurationSecs}
              min={30}
              max={1800}
              hint={t('agentForm.maxDurationHint')}
            />
            <Input
              label={t('agentForm.escalationPhone')}
              value={form.escalationPhone}
              onChange={(e) => set('escalationPhone', e.target.value)}
              error={errors.escalationPhone}
              placeholder="+244 9XX XXX XXX"
              hint={t('agentForm.escalationPhoneHint')}
            />
          </div>
        </Card>

        <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 flex gap-3">
          <Info className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-blue-700">
            <Trans i18nKey="agentForm.infoNote" components={[<strong key="0" />]} />
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            icon={<Save className="h-4 w-4" />}
            loading={save.isPending}
            onClick={() => { if (validate()) save.mutate(); }}
          >
            {isEdit ? t('agentForm.saveChanges') : t('agentForm.createAgent')}
          </Button>
          {id && (
            <Button
              variant="outline"
              icon={<MessageSquare className="h-4 w-4" />}
              onClick={() => navigate(`/agents/${id}/simulate`)}
            >
              {t('agentForm.openSimulator')}
            </Button>
          )}
          <Button variant="ghost" onClick={() => navigate('/agents')}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </>
  );
}
