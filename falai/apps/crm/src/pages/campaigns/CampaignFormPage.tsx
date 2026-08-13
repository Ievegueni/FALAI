import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Megaphone, Info, Bot, FileText, Rocket } from 'lucide-react';
import { agentsApi, campaignsApi, contactsApi, walletApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import { formatAOA, daysOfWeekLabel } from '@/lib/utils';
import type { CallStatus, CampaignMode } from '@/types';

const RETRY_STATUSES = ['NO_ANSWER', 'FAILED'] as const;

export function CampaignFormPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { success, error } = useToast();

  const [mode, setMode] = useState<CampaignMode>('VOICE_AI');
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [scriptText, setScriptText] = useState('');
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [scheduleMode, setScheduleMode] = useState<'NOW' | 'WINDOW'>('NOW');
  const [startHour, setStartHour] = useState(8);
  const [endHour, setEndHour] = useState(18);
  const [daysOfWeek, setDaysOfWeek] = useState([1, 2, 3, 4, 5]);
  const [maxAttempts, setMaxAttempts] = useState(2);
  const [delayMinutes, setDelayMinutes] = useState(60);
  const [retryOn, setRetryOn] = useState<string[]>(['NO_ANSWER']);
  const [throttlePerMinute, setThrottlePerMinute] = useState(5);

  const { data: agents, isLoading: loadingAgents } = useQuery({
    queryKey: ['agents', 'ACTIVE'],
    queryFn: () => agentsApi.list({ status: 'ACTIVE' }),
  });

  const { data: contacts, isLoading: loadingContacts } = useQuery({
    queryKey: ['contacts', 'all'],
    queryFn: () => contactsApi.list({ page: 1 }),
  });

  const { data: wallet } = useQuery({
    queryKey: ['wallet', 'balance'],
    queryFn: walletApi.balance,
  });

  const estimatedCost =
    wallet && selectedContactIds.length > 0 && mode === 'VOICE_AI'
      ? selectedContactIds.length * 2 * wallet.plan.pricePerMinuteCents
      : wallet && selectedContactIds.length > 0 && mode === 'FIXED_SCRIPT'
        ? selectedContactIds.length * wallet.plan.pricePerCallCents
        : null;

  function buildPayload() {
    return {
      name,
      mode,
      ...(mode === 'VOICE_AI' ? { agentId } : { scriptText }),
      contactIds: selectedContactIds,
      scheduleJson: { mode: scheduleMode, startHour, endHour, timezone: 'Africa/Luanda', daysOfWeek },
      retryPolicy: { maxAttempts, delayMinutes, retryOn: retryOn as CallStatus[] },
      throttlePerMinute,
    };
  }

  const create = useMutation({
    mutationFn: () => campaignsApi.create(buildPayload()),
    onSuccess: (campaign) => {
      success(t('campaigns.form.created'));
      navigate(`/campaigns/${campaign.id}`);
    },
    onError: (e: Error) => error(e.message),
  });

  const createAndLaunch = useMutation({
    mutationFn: async () => {
      const campaign = await campaignsApi.create(buildPayload());
      await campaignsApi.launch(campaign.id);
      return campaign;
    },
    onSuccess: (campaign) => {
      success(t('campaigns.launched'));
      navigate(`/campaigns/${campaign.id}`);
    },
    onError: (e: Error) => error(e.message),
  });

  function toggleDay(d: number) {
    setDaysOfWeek((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
    );
  }

  function toggleContact(id: string) {
    setSelectedContactIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function validate(): boolean {
    if (!name.trim()) { error(t('campaigns.form.errNameRequired')); return false; }
    if (mode === 'VOICE_AI' && !agentId) { error(t('campaigns.form.errSelectAgent')); return false; }
    if (mode === 'FIXED_SCRIPT' && !scriptText.trim()) { error(t('campaigns.form.errScriptRequired')); return false; }
    if (selectedContactIds.length === 0) { error(t('campaigns.form.errSelectContact')); return false; }
    if (scheduleMode === 'WINDOW' && startHour >= endHour) { error(t('campaigns.form.errHourOrder')); return false; }
    return true;
  }

  if (loadingAgents || loadingContacts) return <><Header title={t('campaigns.form.title')} /><PageSpinner /></>;

  return (
    <>
      <Header
        title={t('campaigns.form.title')}
        actions={
          <Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => navigate('/campaigns')}>
            {t('common.back')}
          </Button>
        }
      />

      <div className="p-6 max-w-3xl space-y-6">
        {/* Campaign type selector */}
        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('campaigns.form.mode')}</h2>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setMode('VOICE_AI')}
              className={`flex flex-col items-start gap-2 rounded-lg border-2 p-4 text-left transition-colors ${
                mode === 'VOICE_AI'
                  ? 'border-blue-600 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="flex items-center gap-2">
                <Bot className={`h-4 w-4 ${mode === 'VOICE_AI' ? 'text-blue-600' : 'text-gray-400'}`} />
                <span className={`text-sm font-medium ${mode === 'VOICE_AI' ? 'text-blue-700' : 'text-gray-700'}`}>
                  {t('campaigns.form.voiceAi')}
                </span>
              </div>
              <p className="text-xs text-gray-500">{t('campaigns.form.voiceAiDesc')}</p>
            </button>

            <button
              type="button"
              onClick={() => setMode('FIXED_SCRIPT')}
              className={`flex flex-col items-start gap-2 rounded-lg border-2 p-4 text-left transition-colors ${
                mode === 'FIXED_SCRIPT'
                  ? 'border-green-600 bg-green-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="flex items-center gap-2">
                <FileText className={`h-4 w-4 ${mode === 'FIXED_SCRIPT' ? 'text-green-600' : 'text-gray-400'}`} />
                <span className={`text-sm font-medium ${mode === 'FIXED_SCRIPT' ? 'text-green-700' : 'text-gray-700'}`}>
                  {t('campaigns.form.fixedScript')}
                </span>
              </div>
              <p className="text-xs text-gray-500">{t('campaigns.form.fixedScriptDesc')}</p>
            </button>
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('campaigns.form.basicInfo')}</h2>
          <div className="flex flex-col gap-4">
            <Input
              label={t('campaigns.form.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('campaigns.form.namePlaceholder')}
              required
            />

            {mode === 'VOICE_AI' && (
              <Select
                label={t('campaigns.form.agent')}
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                required
              >
                <option value="">{t('campaigns.form.selectAgent')}</option>
                {agents?.data.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </Select>
            )}

            {mode === 'FIXED_SCRIPT' && (
              <div className="flex flex-col gap-1">
                <label className="block text-sm font-medium text-gray-700">
                  {t('campaigns.form.scriptText')}
                  <span className="ml-1 text-red-500">*</span>
                </label>
                <textarea
                  value={scriptText}
                  onChange={(e) => setScriptText(e.target.value)}
                  placeholder={t('campaigns.form.scriptTextPlaceholder')}
                  maxLength={2000}
                  rows={5}
                  className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                />
                <p className="text-xs text-gray-500 flex justify-between">
                  <span>{t('campaigns.form.scriptTextHint')}</span>
                  <span>{scriptText.length}/2000</span>
                </p>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-1">{t('campaigns.form.contacts')}</h2>
          <p className="text-xs text-gray-500 mb-3">{t('campaigns.form.selectedCount', { count: selectedContactIds.length })}</p>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
            {contacts?.data.map((c) => (
              <label
                key={c.id}
                className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 ${c.optedOutAt ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={selectedContactIds.includes(c.id)}
                  onChange={() => !c.optedOutAt && toggleContact(c.id)}
                  disabled={Boolean(c.optedOutAt)}
                  className="rounded"
                />
                <span className="text-sm text-gray-900 flex-1">{c.name}</span>
                <span className="text-xs text-gray-400">{c.phone}</span>
              </label>
            ))}
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('campaigns.form.timeWindow')}</h2>
          {/* "Agora" evita o caso em que a campanha é lançada fora da janela e
              fica parada sem explicação nenhuma para quem a lançou. */}
          <div className="flex gap-2 mb-4">
            {(['NOW', 'WINDOW'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setScheduleMode(m)}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  scheduleMode === m
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {m === 'NOW' ? t('campaigns.form.scheduleNow') : t('campaigns.form.scheduleWindow')}
              </button>
            ))}
          </div>
          {scheduleMode === 'NOW' ? (
            <p className="text-sm text-gray-500">{t('campaigns.form.scheduleNowHint')}</p>
          ) : (
          <>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <Select
              label={t('campaigns.form.startH')}
              value={startHour}
              onChange={(e) => setStartHour(parseInt(e.target.value, 10))}
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
              ))}
            </Select>
            <Select
              label={t('campaigns.form.endH')}
              value={endHour}
              onChange={(e) => setEndHour(parseInt(e.target.value, 10))}
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
              ))}
            </Select>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">{t('campaigns.form.days')}</p>
            <div className="flex gap-2">
              {daysOfWeekLabel().map((label, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => toggleDay(i)}
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-colors ${
                    daysOfWeek.includes(i)
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {label.charAt(0)}
                </button>
              ))}
            </div>
          </div>
          </>
          )}
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('campaigns.form.retryPolicy')}</h2>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label={t('campaigns.form.maxAttempts')}
              type="number"
              value={maxAttempts}
              onChange={(e) => setMaxAttempts(parseInt(e.target.value, 10))}
              min={1}
              max={5}
            />
            <Input
              label={t('campaigns.form.retryInterval')}
              type="number"
              value={delayMinutes}
              onChange={(e) => setDelayMinutes(parseInt(e.target.value, 10))}
              min={5}
            />
          </div>
          <div className="mt-3">
            <p className="text-sm font-medium text-gray-700 mb-2">{t('campaigns.form.retryWhen')}</p>
            <div className="flex gap-4">
              {RETRY_STATUSES.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={retryOn.includes(s)}
                    onChange={() =>
                      setRetryOn((prev) =>
                        prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
                      )
                    }
                    className="rounded"
                  />
                  {s === 'NO_ANSWER' ? t('campaigns.form.noAnswer') : t('campaigns.form.failed')}
                </label>
              ))}
            </div>
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('campaigns.form.dispatchRate')}</h2>
          <Input
            label={t('campaigns.form.callsPerMinute')}
            type="number"
            value={throttlePerMinute}
            onChange={(e) => setThrottlePerMinute(parseInt(e.target.value, 10))}
            min={1}
            max={20}
            hint={t('campaigns.form.callsPerMinuteHint')}
          />
        </Card>

        {estimatedCost !== null && (
          <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 flex gap-3">
            <Info className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-blue-700">
              {mode === 'VOICE_AI' ? (
                <p>{t('campaigns.form.estCostLabel')}: <strong>{formatAOA(estimatedCost)}</strong> ({t('campaigns.form.estCostBreakdown', { count: selectedContactIds.length, price: formatAOA(wallet?.plan.pricePerMinuteCents ?? 0) })})</p>
              ) : (
                <p>{t('campaigns.form.estCostLabel')}: <strong>{formatAOA(estimatedCost)}</strong> ({selectedContactIds.length} × {formatAOA(wallet?.plan.pricePerCallCents ?? 0)}/chamada)</p>
              )}
              <p className="mt-1 text-xs">{t('campaigns.form.estCostNote')}</p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <Button
            className="bg-emerald-600 hover:bg-emerald-700 text-white border-0"
            icon={<Rocket className="h-4 w-4" />}
            loading={createAndLaunch.isPending}
            onClick={() => { if (validate()) createAndLaunch.mutate(); }}
          >
            {t('campaigns.form.createAndLaunch')}
          </Button>
          <Button
            variant="ghost"
            icon={<Megaphone className="h-4 w-4" />}
            loading={create.isPending}
            onClick={() => { if (validate()) create.mutate(); }}
          >
            {t('campaigns.form.create')}
          </Button>
          <Button variant="ghost" onClick={() => navigate('/campaigns')}>{t('common.cancel')}</Button>
        </div>
      </div>
    </>
  );
}
