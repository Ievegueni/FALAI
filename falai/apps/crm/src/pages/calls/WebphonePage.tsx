import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PhoneCall, PhoneOff, Mic, MicOff, Delete, Pause, Play, Headphones } from 'lucide-react';
import { telephonyApi, rejectReasonsApi, supervisionApi, pauseReasonsApi } from '@/lib/api';
import { useWebphone, type RegistrationState } from '@/contexts/WebphoneContext';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Select, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { TypingModal, UntypedList } from './TypingPanel';
import { CallerPanel } from '@/components/calls/CallerPanel';
import { Card } from '@/components/ui/Card';
import { PageSpinner } from '@/components/ui/Spinner';
import { clsx } from '@/lib/utils';

const DIAL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

const REGISTRATION_LABEL: Record<RegistrationState, string> = {
  unregistered: 'webphone.status.unregistered',
  registering: 'webphone.status.registering',
  registered: 'webphone.status.registered',
  failed: 'webphone.status.failed',
};

const REGISTRATION_COLOR: Record<RegistrationState, string> = {
  unregistered: 'text-gray-500',
  registering: 'text-amber-600',
  registered: 'text-green-600',
  failed: 'text-red-600',
};

const OTHER = '__other__';

/**
 * Motivo obrigatório antes de recusar (relatórios de atendimento). A recusa só
 * segue depois de escolhido o motivo; se a chamada deixar de tocar entretanto,
 * o modal fecha e nada se envia.
 */
function RejectReasonModal({ open, legId, onCancel, onRejected }: {
  open: boolean;
  legId: string | null;
  onCancel: () => void;
  onRejected: () => void;
}) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const { data: reasons } = useQuery({
    queryKey: ['reject-reasons'],
    queryFn: () => rejectReasonsApi.list(),
    enabled: open,
  });

  useEffect(() => {
    if (open) { setChoice(''); setNote(''); }
  }, [open]);

  const valid = choice === OTHER ? note.trim().length > 0 : choice !== '';

  const confirm = async () => {
    setSaving(true);
    try {
      // Sem perna (chamada interna, não veio pelo router de entrada) não há
      // onde gravar: recusa-se na mesma. Um erro ao gravar também não pode
      // deixar o telefone a tocar.
      if (legId) {
        await rejectReasonsApi
          .saveForLeg(legId, choice === OTHER ? { note: note.trim() } : { reasonId: choice })
          .catch(() => {});
      }
    } finally {
      setSaving(false);
      onRejected();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={t('webphone.rejectReasonTitle')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={!valid} loading={saving} onClick={() => void confirm()}>
            {t('webphone.reject')}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {[...(reasons ?? []).map((r) => ({ id: r.id, label: r.label })), { id: OTHER, label: t('webphone.rejectOther') }].map((r) => (
          <label key={r.id} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="radio" name="reject-reason" value={r.id} checked={choice === r.id} onChange={() => setChoice(r.id)} />
            {r.label}
          </label>
        ))}
        {choice === OTHER && (
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('webphone.rejectOtherPlaceholder')} rows={2} maxLength={500} autoFocus />
        )}
      </div>
    </Modal>
  );
}

export function WebphonePage() {
  const { t } = useTranslation();
  const {
    extensionId,
    registration,
    callState,
    remoteIdentity,
    incomingLegId,
    error,
    selectExtension,
    call,
    answer,
    hangup,
    reject,
    supervising,
    supervisedMode,
    mute,
    unmute,
    sendDTMF,
  } = useWebphone();

  const [target, setTarget] = useState('');
  const [muted, setMuted] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const qc = useQueryClient();
  // Pausa (melhoria 4): em pausa a extensão não recebe chamadas de entrada.
  const { data: pause } = useQuery({
    queryKey: ['agent-pause', extensionId],
    queryFn: () => supervisionApi.pause(extensionId!),
    enabled: extensionId !== null,
  });
  // Motivos de pausa (fase 5): se o cliente os definiu, pausar pede o motivo.
  const { data: pauseReasons = [] } = useQuery({ queryKey: ['pause-reasons'], queryFn: () => pauseReasonsApi.list(), retry: false });
  const togglePause = useMutation({
    mutationFn: (reasonId?: string) => supervisionApi.setPause(extensionId!, !pause?.paused, reasonId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['agent-pause', extensionId] }),
  });
  const [typingLegId, setTypingLegId] = useState<string | null>(null);
  // Chamada de entrada atendida aqui: quando acabar, abre a tipificação.
  const answeredLegRef = useRef<string | null>(null);

  const { data: extensions, isLoading: loadingExt } = useQuery({
    queryKey: ['telephony', 'extensions'],
    queryFn: telephonyApi.listExtensions,
  });

  useEffect(() => {
    const first = extensions?.[0];
    if (!extensionId && first) selectExtension(first.id);
  }, [extensions, extensionId, selectExtension]);

  const inCall = callState === 'in-call' || callState === 'calling' || callState === 'ringing';
  const incoming = callState === 'incoming';

  // A chamada deixou de tocar (atendeu noutro aparelho, quem ligou desistiu…).
  useEffect(() => {
    if (!incoming) setRejecting(false);
  }, [incoming]);

  useEffect(() => {
    if (callState === 'in-call' && incomingLegId) answeredLegRef.current = incomingLegId;
    if (callState === 'ended' && answeredLegRef.current) {
      setTypingLegId(answeredLegRef.current);
      answeredLegRef.current = null;
    }
  }, [callState, incomingLegId]);

  function toggleMute() {
    if (muted) unmute();
    else mute();
    setMuted((m) => !m);
  }

  if (loadingExt) return (<><Header title={t('webphone.title')} /><PageSpinner /></>);

  return (
    <>
      <Header title={t('webphone.title')} />

      <div className="p-6 flex flex-col gap-6 lg:flex-row lg:items-start">
      <div className="w-full max-w-md space-y-6">
        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('webphone.selectExtension')}</h2>
          {(extensions?.length ?? 0) === 0 ? (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
              {t('webphone.noLine')}
            </div>
          ) : (
            <Select
              value={extensionId ?? ''}
              onChange={(e) => selectExtension(e.target.value)}
              disabled={inCall || incoming}
            >
              {(extensions ?? []).map((ext) => (
                <option key={ext.id} value={ext.id}>
                  {ext.number}{ext.displayName && ext.displayName !== ext.number ? ` — ${ext.displayName}` : ''}
                </option>
              ))}
            </Select>
          )}

          <p className={clsx('mt-3 text-xs font-medium', REGISTRATION_COLOR[registration])}>
            {t(REGISTRATION_LABEL[registration])}
          </p>
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          {extensionId && (
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-gray-100 pt-3">
              <p className="text-xs text-gray-500">
                {pause?.paused ? t('webphone.pausedHint') : t('webphone.availableHint')}
                {pause?.reason && <span className="font-medium text-gray-700"> · {pause.reason.label}</span>}
              </p>
              {!pause?.paused && pauseReasons.length > 0 ? (
                <select
                  className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-700"
                  value=""
                  disabled={togglePause.isPending}
                  onChange={(e) => e.target.value && togglePause.mutate(e.target.value)}
                  aria-label={t('webphone.pause')}
                >
                  <option value="">{t('webphone.pauseWithReason')}</option>
                  {pauseReasons.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              ) : (
                <Button
                  size="sm"
                  variant={pause?.paused ? 'primary' : 'outline'}
                  icon={pause?.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                  loading={togglePause.isPending}
                  onClick={() => togglePause.mutate(undefined)}
                >
                  {pause?.paused ? t('webphone.resume') : t('webphone.pause')}
                </Button>
              )}
            </div>
          )}
        </Card>

        {(supervising || supervisedMode) && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <Headphones className="h-4 w-4" />
            {supervising ? t('webphone.supervising') : t(`webphone.supervised.${supervisedMode}`)}
          </div>
        )}

        <Card>
          {incoming ? (
            <div className="flex flex-col items-center gap-4 py-4">
              <p className="text-sm text-gray-600">{t('webphone.incomingCall')}</p>
              <p className="text-lg font-semibold text-gray-900">{remoteIdentity}</p>
              <div className="flex gap-3">
                <Button variant="danger" icon={<PhoneOff className="h-4 w-4" />} onClick={() => setRejecting(true)}>
                  {t('webphone.reject')}
                </Button>
                <Button icon={<PhoneCall className="h-4 w-4" />} onClick={answer}>
                  {t('webphone.answer')}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <input
                type="text"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                disabled={inCall}
                placeholder={t('webphone.dialPlaceholder')}
                className="w-full mb-4 rounded-lg border border-gray-300 px-4 py-2.5 text-center text-lg tracking-wide focus:outline-none focus:ring-2 focus:ring-blue-500"
              />

              <div className="grid grid-cols-3 gap-2 mb-4">
                {DIAL_KEYS.map((key) => (
                  <button
                    key={key}
                    onClick={() => (inCall ? sendDTMF(key) : setTarget((t) => t + key))}
                    className="h-12 rounded-lg bg-gray-100 hover:bg-gray-200 text-lg font-medium text-gray-800 transition-colors"
                  >
                    {key}
                  </button>
                ))}
              </div>

              {inCall && (
                <div className="mb-4 rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700 text-center">
                  {t(`webphone.callState.${callState}`)} {remoteIdentity}
                </div>
              )}

              <div className="flex items-center justify-center gap-3">
                {!inCall && (
                  <Button
                    icon={<PhoneCall className="h-4 w-4" />}
                    disabled={registration !== 'registered' || !target.trim()}
                    onClick={() => call(target)}
                  >
                    {t('webphone.call')}
                  </Button>
                )}
                {inCall && (
                  <>
                    <Button variant="outline" icon={muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />} onClick={toggleMute}>
                      {muted ? t('webphone.unmute') : t('webphone.mute')}
                    </Button>
                    <Button variant="danger" icon={<PhoneOff className="h-4 w-4" />} onClick={hangup}>
                      {t('webphone.hangup')}
                    </Button>
                  </>
                )}
                {!inCall && target && (
                  <Button variant="ghost" icon={<Delete className="h-4 w-4" />} onClick={() => setTarget((t) => t.slice(0, -1))}>
                    {t('webphone.clear')}
                  </Button>
                )}
              </div>
            </>
          )}
        </Card>
      </div>
      {/* Painel do cliente (melhoria 3): no toque e durante a chamada; ao
          recusar, não atender ou desligar, a sessão acaba e o painel fecha. */}
      {incomingLegId && (incoming || callState === 'in-call') && <CallerPanel key={incomingLegId} legId={incomingLegId} />}
      </div>
      <div className="px-6 pb-6">
        <UntypedList extensionId={extensionId} onPick={setTypingLegId} />
      </div>
      <TypingModal legId={typingLegId} onClose={() => setTypingLegId(null)} />
      <RejectReasonModal
        open={rejecting}
        legId={incomingLegId}
        onCancel={() => setRejecting(false)}
        onRejected={() => { setRejecting(false); reject(); }}
      />
    </>
  );
}
