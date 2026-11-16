import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ClipboardList, Play } from 'lucide-react';
import { callsApi } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { clsx, formatDuration } from '@/lib/utils';

type Divergence = { field: string; formValue: string; said: string; quote: string };

/**
 * O que se ouve e se lê de uma chamada: gravação, transcrição sincronizada
 * (clicar numa frase salta para esse ponto do áudio), métricas da conversa, a
 * ficha preenchida e — numa avaliação da IA — as divergências entre a ficha e o
 * que o cliente disse. Serve o detalhe da chamada e a revisão do auditor.
 */
export function CallEvidence({ callId, divergences }: { callId: string; divergences?: Divergence[] | undefined }) {
  const { t } = useTranslation();
  const { data: call } = useQuery({ queryKey: ['calls', callId], queryFn: () => callsApi.get(callId) });
  const audio = useRef<HTMLAudioElement>(null);
  const [now, setNow] = useState(0);

  // A gravação vem por uma rota autenticada, por isso chega como blob e
  // transforma-se num object URL — que tem de ser libertado ao sair.
  const [src, setSrc] = useState<string | null>(null);
  const hasRecording = !!call?.recordingUrl;
  useEffect(() => {
    if (!hasRecording) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    void callsApi
      .recording(callId)
      .then((url) => {
        if (cancelled) { URL.revokeObjectURL(url); return; }
        objectUrl = url;
        setSrc(url);
      })
      .catch(() => setSrc(null));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hasRecording, callId]);

  if (!call) return null;
  const utterances = call.transcript?.source === 'recording' ? call.transcript.utterances : [];
  const m = call.metrics;
  const seek = (secs: number) => {
    if (!audio.current) return;
    audio.current.currentTime = secs;
    void audio.current.play();
  };
  let current = -1;
  utterances.forEach((u, i) => { if (u.start <= now + 0.05) current = i; });

  return (
    <>
      {call.recordingUrl && src && (
        <Card className="sticky top-0 z-10">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Play className="h-4 w-4" /> {t('calls.detail.recording')}
          </h2>
          <audio ref={audio} controls className="w-full" src={src} onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}>
            {t('calls.detail.audioUnsupported')}
          </audio>
        </Card>
      )}

      {!!divergences?.length && (
        <Card className="border-amber-200 bg-amber-50">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-900">
            <AlertTriangle className="h-4 w-4" /> {t('quality.divergences')}
          </h2>
          <ul className="space-y-1.5 text-sm text-amber-900">
            {divergences.map((d, i) => (
              <li key={i}>
                <span className="font-medium">{d.field}</span>: {t('quality.divergenceLine', { form: d.formValue || '—', said: d.said })}
                {d.quote && <span className="italic text-amber-700"> — “{d.quote}”</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {call.formData && (
        <Card>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
            <ClipboardList className="h-4 w-4" /> {call.formData.form}
          </h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {Object.entries(call.formData.values).filter(([, v]) => v !== null).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-gray-500">{k}</dt>
                <dd className="text-gray-900">{typeof v === 'boolean' ? t(v ? 'common.yes' : 'common.no') : String(v)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      {m && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-gray-900">{t('calls.detail.metricsTitle')}</h2>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {m.talk?.map((s) => (
              <span key={s.speaker}>
                <span className="text-gray-500">{t('calls.detail.speaker', { n: s.speaker + 1 })}:</span>{' '}
                <span className="font-medium tabular-nums">{formatDuration(s.secs)} ({s.pct}%)</span>
              </span>
            ))}
            {m.longestSilenceSecs !== null && (
              <span><span className="text-gray-500">{t('calls.detail.longestSilence')}:</span> <span className="font-medium tabular-nums">{m.longestSilenceSecs}s</span></span>
            )}
            {m.interruptions !== null && (
              <span><span className="text-gray-500">{t('calls.detail.interruptions')}:</span> <span className="font-medium tabular-nums">{m.interruptions}</span></span>
            )}
          </div>
          {m.forbidden.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-red-700">{t('calls.detail.forbiddenSaid')}:</span>
              {m.forbidden.map((f, i) => (
                <button key={i} type="button" onClick={() => seek(f.start)} className="rounded bg-red-50 px-2 py-0.5 text-red-700 hover:bg-red-100">
                  “{f.word}” · {formatDuration(Math.floor(f.start))} · {t('calls.detail.speaker', { n: f.speaker + 1 })}
                </button>
              ))}
            </div>
          )}
        </Card>
      )}

      {utterances.length > 0 && (
        <Card padding={false}>
          <div className="border-b border-gray-200 px-6 py-4">
            <h2 className="text-sm font-semibold text-gray-900">{t('calls.detail.transcript')}</h2>
            <p className="mt-0.5 text-xs text-gray-400">{t('calls.detail.autoTranscript')}</p>
          </div>
          <div className="divide-y divide-gray-50">
            {utterances.map((u, i) => (
              <button
                key={i}
                type="button"
                onClick={() => seek(u.start)}
                className={clsx('flex w-full gap-4 px-6 py-2.5 text-left hover:bg-gray-50', i === current && now > 0 && 'bg-blue-50')}
              >
                <span className={clsx('w-24 flex-shrink-0 text-xs tabular-nums', u.speaker === 0 ? 'text-blue-600' : 'text-emerald-600')}>
                  {formatDuration(Math.floor(u.start))} · {t('calls.detail.speaker', { n: u.speaker + 1 })}
                </span>
                <span className="flex-1 text-sm text-gray-800">{u.text}</span>
              </button>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
