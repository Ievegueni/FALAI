import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { ArrowLeft, Send, RotateCcw, Bot, User } from 'lucide-react';
import { agentsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import type { SimMessage } from '@/types';

interface BubbleProps {
  message: SimMessage;
}

function Bubble({ message }: BubbleProps) {
  const isAssistant = message.role === 'assistant';
  return (
    <div className={`flex gap-3 ${isAssistant ? '' : 'flex-row-reverse'}`}>
      <div
        className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm ${
          isAssistant ? 'bg-blue-100 text-blue-700' : 'bg-gray-200 text-gray-700'
        }`}
      >
        {isAssistant ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
      </div>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${
          isAssistant
            ? 'rounded-tl-none bg-blue-50 text-gray-900'
            : 'rounded-tr-none bg-gray-900 text-white'
        }`}
      >
        {message.content}
      </div>
    </div>
  );
}

export function SimulatorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { error: toastError } = useToast();
  const [history, setHistory] = useState<SimMessage[]>([]);
  const [input, setInput] = useState('');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: agent, isLoading, isError } = useQuery({
    queryKey: ['agents', id],
    queryFn: () => agentsApi.get(id!),
    enabled: Boolean(id),
    retry: false,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  const simulate = useMutation({
    mutationFn: (message: string) =>
      agentsApi.simulate(id!, { message, history, variables }),
    onSuccess: (res, message) => {
      setHistory((h) => [
        ...h,
        { role: 'user', content: message },
        { role: 'assistant', content: res.reply },
      ]);
      if (res.action === 'end') {
        setTimeout(() => {
          setHistory((h) => [...h, { role: 'assistant', content: '— Chamada terminada —' }]);
        }, 300);
      }
    },
    onError: (e: Error) => toastError(e.message),
  });

  function handleSend() {
    if (!input.trim() || simulate.isPending) return;
    const msg = input.trim();
    setInput('');
    simulate.mutate(msg);
  }

  function handleReset() {
    setHistory([]);
    setInput('');
  }

  if (isLoading) return <><Header title="Simulador" /><PageSpinner /></>;

  if (isError || !agent) {
    return (
      <>
        <Header title="Simulador" />
        <div className="p-6 text-center">
          <p className="text-sm text-gray-500 mb-4">Agente não encontrado ou já não existe.</p>
          <Button variant="outline" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => navigate('/agents')}>
            Voltar aos agentes
          </Button>
        </div>
      </>
    );
  }

  const variableKeys = Object.keys(agent.variablesSchema);

  return (
    <>
      <Header
        title={`Simulador — ${agent.name}`}
        actions={
          <Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => navigate(`/agents/${id}`)}>
            Voltar
          </Button>
        }
      />

      <div className="p-6 flex gap-6 h-[calc(100vh-56px)] overflow-hidden">
        {/* Chat */}
        <Card padding={false} className="flex-1 flex flex-col overflow-hidden">
          <div className="border-b border-gray-200 px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-gray-900">{agent.name}</p>
              <p className="text-xs text-gray-400">Simulação em texto — sem custo real</p>
            </div>
            <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={handleReset}>
              Reiniciar
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {history.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <Bot className="h-10 w-10 text-gray-300 mb-3" />
                <p className="text-sm font-medium text-gray-500">{agent.name}</p>
                <p className="text-xs text-gray-400 mt-1">
                  Escreva uma mensagem para iniciar a conversa de teste.
                </p>
              </div>
            )}
            {history.map((msg, i) => (
              <Bubble key={i} message={msg} />
            ))}
            {simulate.isPending && (
              <div className="flex gap-3">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700">
                  <Bot className="h-4 w-4" />
                </div>
                <div className="flex items-center gap-1 rounded-2xl rounded-tl-none bg-blue-50 px-4 py-2.5">
                  <span className="h-2 w-2 rounded-full bg-blue-400 animate-bounce [animation-delay:-0.3s]" />
                  <span className="h-2 w-2 rounded-full bg-blue-400 animate-bounce [animation-delay:-0.15s]" />
                  <span className="h-2 w-2 rounded-full bg-blue-400 animate-bounce" />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="border-t border-gray-200 p-3 flex gap-2">
            <input
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Escreva como se fosse o cliente..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              disabled={simulate.isPending}
            />
            <Button
              icon={<Send className="h-4 w-4" />}
              onClick={handleSend}
              loading={simulate.isPending}
              disabled={!input.trim()}
            >
              Enviar
            </Button>
          </div>
        </Card>

        {/* Variables panel */}
        {variableKeys.length > 0 && (
          <div className="w-72 flex-shrink-0">
            <Card>
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Variáveis da chamada</h3>
              <div className="space-y-3">
                {variableKeys.map((key) => {
                  const field = agent.variablesSchema[key];
                  if (!field) return null;
                  return (
                    <div key={key}>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        {`{{${key}}}`} — {field.label}
                      </label>
                      <input
                        className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        value={variables[key] ?? ''}
                        onChange={(e) => setVariables((v) => ({ ...v, [key]: e.target.value }))}
                        placeholder={field.example ?? `Valor de ${key}`}
                      />
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-gray-400">
                Estas variáveis serão injectadas no prompt do agente.
              </p>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
