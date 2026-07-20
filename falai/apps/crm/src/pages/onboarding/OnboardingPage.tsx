import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { useTranslation, Trans } from 'react-i18next';
import { Bot, Users, Phone, CheckCircle, ArrowRight } from 'lucide-react';
import { agentsApi, contactsApi, callsApi } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';

// Conteúdo operacional do agente (prompt em PT — o agente liga em português).
// O label e a descrição visíveis vêm das traduções (onboarding.templates.<id>).
const TEMPLATES = [
  {
    id: 'cobranca',
    objective: 'Contactar o cliente sobre a dívida em atraso e negociar uma data ou plano de pagamento.',
    tone: 'Profissional, empático e respeitoso. Nunca agressivo nem ameaçador.',
    dataToCollect: 'Confirmação de recebimento do aviso, data prevista de pagamento, valor disponível.',
    neverSay: 'Ameaças legais, juros não acordados, informações de outros clientes.',
  },
  {
    id: 'confirmacao',
    objective: 'Confirmar recepção do pedido e recolher satisfação numa escala de 1 a 5.',
    tone: 'Cordial, breve e eficiente. Máximo 2 minutos.',
    dataToCollect: 'Se recebeu, condição da entrega, nota de satisfação 1–5.',
    neverSay: 'Informações de outros pedidos ou outros clientes.',
  },
  {
    id: 'pesquisa',
    objective: 'Recolher NPS (0–10) e o principal motivo da nota.',
    tone: 'Amigável, curioso e grato. Máximo 3 minutos.',
    dataToCollect: 'Nota NPS, razão principal, sugestão de melhoria.',
    neverSay: 'Nomes de concorrentes.',
  },
];

type Step = 'template' | 'contact' | 'call' | 'done';

export function OnboardingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { refreshMe } = useAuth();
  const { success, error } = useToast();

  const [step, setStep] = useState<Step>('template');
  const [selectedTemplate, setSelectedTemplate] = useState<typeof TEMPLATES[0] | null>(null);
  const [agentId, setAgentId] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [callId, setCallId] = useState('');

  const templateLabel = (id: string) => t(`onboarding.templates.${id}.label`);

  const createAgent = useMutation({
    mutationFn: (tpl: typeof TEMPLATES[0]) =>
      agentsApi.create({
        name: templateLabel(tpl.id),
        objective: tpl.objective,
        tone: tpl.tone,
        dataToCollect: tpl.dataToCollect,
        neverSay: tpl.neverSay,
        maxDurationSecs: 180,
      }),
    onSuccess: (agent) => {
      setAgentId(agent.id);
      setStep('contact');
    },
    onError: (e: Error) => error(e.message),
  });

  const makeCall = useMutation({
    mutationFn: () => callsApi.create({ agentId, to: contactPhone }),
    onSuccess: (call) => {
      setCallId(call.id);
      setStep('done');
      success(t('onboarding.callStarted'));
    },
    onError: (e: Error) => error(e.message),
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-blue-950 flex items-center justify-center p-4">
      <div className="w-full max-w-xl">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="mx-auto mb-3 inline-flex items-center justify-center rounded-xl bg-white px-5 py-3 shadow-lg">
            <img src="/logo.png" alt="Comunica" className="h-10 w-auto" />
          </div>
          <h1 className="text-2xl font-bold text-white">{t('onboarding.welcome')}</h1>
          <p className="text-slate-400 mt-1 text-sm">{t('onboarding.intro')}</p>
        </div>

        {/* Steps indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {(['template', 'contact', 'call', 'done'] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                  s === step
                    ? 'bg-blue-500 text-white'
                    : ['done'].includes(step) || (['contact', 'call', 'done'].includes(step) && i < (['template', 'contact', 'call', 'done'] as Step[]).indexOf(step))
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-slate-400'
                }`}
              >
                {i + 1}
              </div>
              {i < 3 && <div className={`h-0.5 w-6 ${i < (['template', 'contact', 'call', 'done'] as Step[]).indexOf(step) ? 'bg-blue-500' : 'bg-slate-700'}`} />}
            </div>
          ))}
        </div>

        <div className="rounded-2xl bg-white p-8 shadow-2xl">
          {/* Step 1: Template */}
          {step === 'template' && (
            <div>
              <div className="flex items-center gap-3 mb-5">
                <div className="rounded-lg bg-blue-100 p-2 text-blue-600"><Bot className="h-5 w-5" /></div>
                <div>
                  <h2 className="text-base font-semibold text-gray-900">{t('onboarding.chooseTemplate')}</h2>
                  <p className="text-xs text-gray-500">{t('onboarding.chooseTemplateHint')}</p>
                </div>
              </div>
              <div className="space-y-3">
                {TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    onClick={() => setSelectedTemplate(tpl)}
                    className={`w-full rounded-xl border-2 p-4 text-left transition-all ${
                      selectedTemplate?.id === tpl.id
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <p className="text-sm font-semibold text-gray-900">{templateLabel(tpl.id)}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{t(`onboarding.templates.${tpl.id}.description`)}</p>
                  </button>
                ))}
              </div>
              <Button
                className="mt-6 w-full h-11"
                icon={<ArrowRight className="h-4 w-4" />}
                disabled={!selectedTemplate}
                loading={createAgent.isPending}
                onClick={() => { if (selectedTemplate) createAgent.mutate(selectedTemplate); }}
              >
                {t('common.continue')}
              </Button>
            </div>
          )}

          {/* Step 2: Contact */}
          {step === 'contact' && (
            <div>
              <div className="flex items-center gap-3 mb-5">
                <div className="rounded-lg bg-emerald-100 p-2 text-emerald-600"><Users className="h-5 w-5" /></div>
                <div>
                  <h2 className="text-base font-semibold text-gray-900">{t('onboarding.testNumber')}</h2>
                  <p className="text-xs text-gray-500">{t('onboarding.testNumberHint')}</p>
                </div>
              </div>
              <Input
                label={t('onboarding.phoneLabel')}
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                placeholder="+244 9XX XXX XXX"
                hint={t('onboarding.phoneHint')}
                required
                autoFocus
              />
              <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-700">
                <Trans
                  i18nKey="onboarding.testCallWarning"
                  values={{ agent: selectedTemplate ? templateLabel(selectedTemplate.id) : '' }}
                  components={[<strong key="0" />]}
                />
              </div>
              <div className="flex gap-3 mt-6">
                <Button variant="outline" onClick={() => setStep('template')}>{t('common.back')}</Button>
                <Button
                  className="flex-1 h-11"
                  icon={<Phone className="h-4 w-4" />}
                  disabled={!contactPhone.trim()}
                  loading={makeCall.isPending}
                  onClick={() => makeCall.mutate()}
                >
                  {t('onboarding.callNow')}
                </Button>
              </div>
            </div>
          )}

          {/* Step 4: Done */}
          {step === 'done' && (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
                <CheckCircle className="h-8 w-8 text-emerald-600" />
              </div>
              <h2 className="text-xl font-bold text-gray-900">{t('onboarding.callInProgress')}</h2>
              <p className="text-sm text-gray-500 mt-2 mb-6">
                <Trans
                  i18nKey="onboarding.callingText"
                  values={{
                    agent: selectedTemplate ? templateLabel(selectedTemplate.id) : '',
                    phone: contactPhone,
                  }}
                  components={[<strong key="0" />, <strong key="1" />]}
                />
              </p>
              <div className="flex flex-col gap-3">
                <Button
                  className="w-full h-11"
                  onClick={() => navigate(`/calls/${callId}`)}
                >
                  {t('onboarding.watchLive')}
                </Button>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => navigate('/dashboard')}
                >
                  {t('onboarding.goToDashboard')}
                </Button>
              </div>
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-slate-500">
          {t('common.support')}: <span className="text-slate-300">+244 924 572 875</span>
        </p>
      </div>
    </div>
  );
}
