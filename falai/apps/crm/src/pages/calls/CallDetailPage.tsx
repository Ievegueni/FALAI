import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Phone, Clock, DollarSign, XCircle, Play } from 'lucide-react';
import { callsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import {
  callStatusLabel,
  callStatusColor,
  formatDate,
  formatDuration,
  formatAOA,
  formatPhone,
} from '@/lib/utils';

export function CallDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { success, error } = useToast();

  const { data: call, isLoading } = useQuery({
    queryKey: ['calls', id],
    queryFn: () => callsApi.get(id!),
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status && ['IN_PROGRESS', 'DIALING', 'RINGING', 'QUEUED'].includes(status) ? 3000 : false;
    },
  });

  const cancel = useMutation({
    mutationFn: () => callsApi.cancel(id!),
    onSuccess: () => { success(t('calls.detail.cancelled')); void qc.invalidateQueries({ queryKey: ['calls', id] }); },
    onError: (e: Error) => error(e.message),
  });

  if (isLoading) return <><Header title={t('calls.detail.callTitle')} /><PageSpinner /></>;
  if (!call) return <><Header title={t('calls.detail.callTitle')} /><div className="p-6 text-sm text-gray-500">{t('calls.detail.notFound')}</div></>;

  const canCancel = ['QUEUED', 'DIALING', 'RINGING'].includes(call.status);
  const isLive = ['DIALING', 'RINGING', 'IN_PROGRESS'].includes(call.status);

  return (
    <>
      <Header
        title={t('calls.detail.title')}
        actions={
          <Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => navigate('/calls')}>
            {t('common.back')}
          </Button>
        }
      />

      <div className="p-6 max-w-3xl space-y-6">
        {/* Status header */}
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${isLive ? 'bg-green-100' : 'bg-gray-100'}`}>
                <Phone className={`h-6 w-6 ${isLive ? 'text-green-600' : 'text-gray-500'}`} />
              </div>
              <div>
                <p className="text-lg font-semibold text-gray-900">
                  {call.contact?.name ?? formatPhone(call.to)}
                </p>
                <p className="text-sm text-gray-500">
                  {formatPhone(call.to)}
                  {' · '}
                  {call.kind === 'OTP'
                    ? t('calls.detail.otpVerification')
                    : call.kind === 'DIRECT'
                      ? t('calls.detail.directCall')
                      : call.agent?.name || '—'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge className={callStatusColor[call.status]}>{callStatusLabel(call.status)}</Badge>
              {isLive && (
                <span className="flex h-2 w-2">
                  <span className="animate-ping absolute h-2 w-2 rounded-full bg-green-400 opacity-75" />
                  <span className="relative h-2 w-2 rounded-full bg-green-500" />
                </span>
              )}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-4 pt-4 border-t border-gray-100">
            <div className="text-center">
              <p className="text-xs text-gray-500">{t('calls.detail.duration')}</p>
              <p className="mt-1 text-sm font-semibold text-gray-900">
                {call.durationSecs !== null ? formatDuration(call.durationSecs) : '—'}
              </p>
            </div>
            <div className="text-center">
              <p className="text-xs text-gray-500">{t('calls.detail.cost')}</p>
              <p className="mt-1 text-sm font-semibold text-gray-900">
                {call.costCents !== null ? formatAOA(call.costCents) : '—'}
              </p>
            </div>
            <div className="text-center">
              <p className="text-xs text-gray-500">{t('calls.detail.date')}</p>
              <p className="mt-1 text-sm font-semibold text-gray-900">{formatDate(call.createdAt)}</p>
            </div>
          </div>

          {call.outcome && (
            <div className="mt-4 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
              <p className="text-xs font-medium text-emerald-700 mb-1">{t('calls.detail.outcome')}</p>
              <p className="text-sm text-emerald-900">{call.outcome}</p>
            </div>
          )}

          {canCancel && (
            <div className="mt-4 flex gap-2">
              <Button
                variant="danger"
                size="sm"
                icon={<XCircle className="h-3.5 w-3.5" />}
                loading={cancel.isPending}
                onClick={() => { if (confirm(t('calls.detail.cancelConfirm'))) cancel.mutate(); }}
              >
                {t('calls.detail.cancelCall')}
              </Button>
            </div>
          )}
        </Card>

        {/* Recording */}
        {call.recordingUrl && (
          <Card>
            <h2 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <Play className="h-4 w-4" /> {t('calls.detail.recording')}
            </h2>
            <audio controls className="w-full" src={call.recordingUrl}>
              {t('calls.detail.audioUnsupported')}
            </audio>
          </Card>
        )}

        {/* Transcript */}
        {call.turns && call.turns.length > 0 && (
          <Card padding={false}>
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-sm font-semibold text-gray-900">{t('calls.detail.transcript')}</h2>
              <p className="text-xs text-gray-400 mt-0.5">{t('calls.detail.turns', { count: call.turns.length })}</p>
            </div>
            <div className="divide-y divide-gray-50">
              {call.turns.map((turn) => (
                <div key={turn.id} className="px-6 py-3 flex gap-4">
                  <div className="w-16 flex-shrink-0">
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded ${
                        turn.role === 'agent'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {turn.role === 'agent' ? t('calls.detail.agent') : t('calls.detail.customer')}
                    </span>
                  </div>
                  <p className="flex-1 text-sm text-gray-800">{turn.text}</p>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Variables */}
        {call.variables && Object.keys(call.variables).length > 0 && (
          <Card>
            <h2 className="text-sm font-semibold text-gray-900 mb-3">{t('calls.detail.variablesUsed')}</h2>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(call.variables).map(([k, v]) => (
                <div key={k} className="text-xs">
                  <span className="font-medium text-gray-500">{`{{${k}}}`}</span>
                  <span className="ml-2 text-gray-900">{v}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
