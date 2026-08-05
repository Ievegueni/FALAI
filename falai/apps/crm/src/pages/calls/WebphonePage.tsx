import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PhoneCall, PhoneOff, Mic, MicOff, Delete } from 'lucide-react';
import { telephonyApi } from '@/lib/api';
import { useWebphone, type RegistrationState } from '@/contexts/WebphoneContext';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Input';
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

export function WebphonePage() {
  const { t } = useTranslation();
  const {
    extensionId,
    registration,
    callState,
    remoteIdentity,
    error,
    selectExtension,
    call,
    answer,
    hangup,
    mute,
    unmute,
    sendDTMF,
  } = useWebphone();

  const [target, setTarget] = useState('');
  const [muted, setMuted] = useState(false);

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

  function toggleMute() {
    if (muted) unmute();
    else mute();
    setMuted((m) => !m);
  }

  if (loadingExt) return (<><Header title={t('webphone.title')} /><PageSpinner /></>);

  return (
    <>
      <Header title={t('webphone.title')} />

      <div className="p-6 max-w-md space-y-6">
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
        </Card>

        <Card>
          {incoming ? (
            <div className="flex flex-col items-center gap-4 py-4">
              <p className="text-sm text-gray-600">{t('webphone.incomingCall')}</p>
              <p className="text-lg font-semibold text-gray-900">{remoteIdentity}</p>
              <div className="flex gap-3">
                <Button variant="danger" icon={<PhoneOff className="h-4 w-4" />} onClick={hangup}>
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
    </>
  );
}
