import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Bot, Users, Phone, CheckCircle, ArrowRight } from 'lucide-react';
import { agentsApi, contactsApi, callsApi } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';

const TEMPLATES = [
  {
    id: 'cobranca',
    label: 'Cobrança amigável',
    description: 'Contactar clientes com dívidas em atraso e negociar plano de pagamento.',
    objective: 'Contactar o cliente sobre a dívida em atraso e negociar uma data ou plano de pagamento.',
    tone: 'Profissional, empático e respeitoso. Nunca agressivo nem ameaçador.',
    dataToCollect: 'Confirmação de recebimento do aviso, data prevista de pagamento, valor disponível.',
    neverSay: 'Ameaças legais, juros não acordados, informações de outros clientes.',
  },
  {
    id: 'confirmacao',
    label: 'Confirmação de entrega',
    description: 'Confirmar que o cliente recebeu o pedido e recolher feedback.',
    objective: 'Confirmar recepção do pedido e recolher satisfação numa escala de 1 a 5.',
    tone: 'Cordial, breve e eficiente. Máximo 2 minutos.',
    dataToCollect: 'Se recebeu, condição da entrega, nota de satisfação 1–5.',
    neverSay: 'Informações de outros pedidos ou outros clientes.',
  },
  {
    id: 'pesquisa',
    label: 'Pesquisa de satisfação',
    description: 'Medir NPS e recolher feedback sobre o serviço.',
    objective: 'Recolher NPS (0–10) e o principal motivo da nota.',
    tone: 'Amigável, curioso e grato. Máximo 3 minutos.',
    dataToCollect: 'Nota NPS, razão principal, sugestão de melhoria.',
    neverSay: 'Nomes de concorrentes.',
  },
];

type Step = 'template' | 'contact' | 'call' | 'done';

export function OnboardingPage() {
  const navigate = useNavigate();
  const { refreshMe } = useAuth();
  const { success, error } = useToast();

  const [step, setStep] = useState<Step>('template');
  const [selectedTemplate, setSelectedTemplate] = useState<typeof TEMPLATES[0] | null>(null);
  const [agentId, setAgentId] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [callId, setCallId] = useState('');

  const createAgent = useMutation({
    mutationFn: (t: typeof TEMPLATES[0]) =>
      agentsApi.create({
        name: t.label,
        objective: t.objective,
        tone: t.tone,
        dataToCollect: t.dataToCollect,
        neverSay: t.neverSay,
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
      success('Chamada de teste iniciada!');
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
          <h1 className="text-2xl font-bold text-white">Bem-vindo ao Falaí</h1>
          <p className="text-slate-400 mt-1 text-sm">Vamos criar o seu primeiro agente e fazer uma chamada de teste.</p>
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
                  <h2 className="text-base font-semibold text-gray-900">Escolha um template</h2>
                  <p className="text-xs text-gray-500">Personalize depois no editor.</p>
                </div>
              </div>
              <div className="space-y-3">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setSelectedTemplate(t)}
                    className={`w-full rounded-xl border-2 p-4 text-left transition-all ${
                      selectedTemplate?.id === t.id
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <p className="text-sm font-semibold text-gray-900">{t.label}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{t.description}</p>
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
                Continuar
              </Button>
            </div>
          )}

          {/* Step 2: Contact */}
          {step === 'contact' && (
            <div>
              <div className="flex items-center gap-3 mb-5">
                <div className="rounded-lg bg-emerald-100 p-2 text-emerald-600"><Users className="h-5 w-5" /></div>
                <div>
                  <h2 className="text-base font-semibold text-gray-900">Número de teste</h2>
                  <p className="text-xs text-gray-500">Recomendamos o seu próprio número.</p>
                </div>
              </div>
              <Input
                label="Número de telemóvel"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                placeholder="+244 9XX XXX XXX"
                hint="Formato +244XXXXXXXXX"
                required
                autoFocus
              />
              <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-700">
                Vai receber uma chamada de teste do agente <strong>{selectedTemplate?.label}</strong>. A chamada é real e tem custo normal.
              </div>
              <div className="flex gap-3 mt-6">
                <Button variant="outline" onClick={() => setStep('template')}>Voltar</Button>
                <Button
                  className="flex-1 h-11"
                  icon={<Phone className="h-4 w-4" />}
                  disabled={!contactPhone.trim()}
                  loading={makeCall.isPending}
                  onClick={() => makeCall.mutate()}
                >
                  Ligar agora
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
              <h2 className="text-xl font-bold text-gray-900">Chamada em curso!</h2>
              <p className="text-sm text-gray-500 mt-2 mb-6">
                O agente <strong>{selectedTemplate?.label}</strong> está a ligar para <strong>{contactPhone}</strong>.
                Atenda e experimente a conversa.
              </p>
              <div className="flex flex-col gap-3">
                <Button
                  className="w-full h-11"
                  onClick={() => navigate(`/calls/${callId}`)}
                >
                  Ver chamada em tempo real
                </Button>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => navigate('/dashboard')}
                >
                  Ir para o dashboard
                </Button>
              </div>
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-slate-500">
          Suporte: <span className="text-slate-300">+244 924 572 875</span>
        </p>
      </div>
    </div>
  );
}
