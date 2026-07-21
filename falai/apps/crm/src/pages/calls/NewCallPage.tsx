import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Phone, Info } from 'lucide-react';
import { agentsApi, callsApi, walletApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import { formatAOA } from '@/lib/utils';

export function NewCallPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { success, error } = useToast();

  const [agentId, setAgentId] = useState('');
  const [to, setTo] = useState('');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [scheduledAt, setScheduledAt] = useState('');

  const { data: agentsData, isLoading: loadingAgents } = useQuery({
    queryKey: ['agents', 'ACTIVE'],
    queryFn: () => agentsApi.list({ status: 'ACTIVE' }),
  });

  const { data: wallet } = useQuery({
    queryKey: ['wallet', 'balance'],
    queryFn: walletApi.balance,
  });

  const selectedAgent = agentsData?.data.find((a) => a.id === agentId);
  const variableKeys = selectedAgent?.variablesSchema ? Object.keys(selectedAgent.variablesSchema) : [];

  const create = useMutation({
    mutationFn: () =>
      callsApi.create({
        agentId,
        to,
        variables: Object.keys(variables).length > 0 ? variables : undefined,
        scheduledAt: scheduledAt || undefined,
      }),
    onSuccess: (call) => {
      success(t('calls.new.started'));
      navigate(`/calls/${call.id}`);
    },
    onError: (e: Error) => error(e.message),
  });

  function validate(): boolean {
    if (!agentId) { error(t('calls.new.errSelectAgent')); return false; }
    if (!to.trim()) { error(t('calls.new.errDestination')); return false; }
    return true;
  }

  if (loadingAgents) return <><Header title={t('calls.new.title')} /><PageSpinner /></>;

  const activeAgents = agentsData?.data ?? [];

  return (
    <>
      <Header
        title={t('calls.new.title')}
        actions={
          <Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => navigate('/calls')}>
            {t('common.back')}
          </Button>
        }
      />

      <div className="p-6 max-w-xl space-y-6">
        {wallet && (
          <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 flex items-center gap-3">
            <Info className="h-4 w-4 text-blue-600 flex-shrink-0" />
            <div className="text-sm text-blue-700">
              {t('calls.new.balanceInfo')}: <strong>{formatAOA(wallet.balanceCents)}</strong> · {formatAOA(wallet.plan.pricePerMinuteCents)}/min
            </div>
          </div>
        )}

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('calls.new.configureCall')}</h2>
          <div className="flex flex-col gap-4">
            <Select
              label={t('calls.new.agent')}
              value={agentId}
              onChange={(e) => { setAgentId(e.target.value); setVariables({}); }}
              required
            >
              <option value="">{t('calls.new.selectAgent')}</option>
              {activeAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </Select>

            {activeAgents.length === 0 && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-700">
                {t('calls.new.noActiveAgents')}
              </div>
            )}

            <Input
              label={t('calls.new.destination')}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="+244 9XX XXX XXX"
              hint={t('calls.new.phoneHint')}
              required
            />

            <Input
              label={t('calls.new.scheduleFor')}
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              hint={t('calls.new.scheduleHint')}
            />
          </div>
        </Card>

        {variableKeys.length > 0 && (
          <Card>
            <h2 className="text-sm font-semibold text-gray-900 mb-4">
              {t('calls.new.agentVariables')}
            </h2>
            <div className="flex flex-col gap-3">
              {variableKeys.map((key) => {
                const field = selectedAgent?.variablesSchema[key];
                if (!field) return null;
                return (
                  <Input
                    key={key}
                    label={`${field.label} ({{${key}}})`}
                    value={variables[key] ?? ''}
                    onChange={(e) => setVariables((v) => ({ ...v, [key]: e.target.value }))}
                    placeholder={field.example ?? t('calls.new.varValuePlaceholder', { key })}
                    required={field.required}
                    hint={field.required ? t('calls.new.requiredHint') : t('calls.new.optionalHint')}
                  />
                );
              })}
            </div>
          </Card>
        )}

        <div className="flex items-center gap-3">
          <Button
            icon={<Phone className="h-4 w-4" />}
            loading={create.isPending}
            onClick={() => { if (validate()) create.mutate(); }}
          >
            {scheduledAt ? t('calls.new.scheduleCall') : t('calls.new.callNow')}
          </Button>
          <Button variant="ghost" onClick={() => navigate('/calls')}>{t('common.cancel')}</Button>
        </div>
      </div>
    </>
  );
}
