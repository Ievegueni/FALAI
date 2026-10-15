import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
// A JsSIP são ~1 MB e este Provider está montado em toda a aplicação (para a
// chamada de entrada tocar em qualquer página). Importada estaticamente,
// entrava no bundle de arranque e era descarregada por quem só quer abrir o
// dashboard. Só se carrega quando o agente escolhe mesmo uma linha.
import type * as JsSIPType from 'jssip';
import type { RTCSession } from 'jssip/lib/RTCSession';
import type { RTCSessionEvent } from 'jssip/lib/UA';
import { webphoneApi, type SupervisionMode } from '@/lib/api';
import { useTenantEvents } from '@/lib/tenantEvents';
import { playAutoAnswerBeep, playQueueAlert, startRingback, startRingtone, stopRingback, stopRingtone, unlockRingtone } from '@/lib/ringtone';
import { useToast } from '@/contexts/ToastContext';

export type RegistrationState = 'unregistered' | 'registering' | 'registered' | 'failed';
export type CallState = 'idle' | 'calling' | 'ringing' | 'incoming' | 'in-call' | 'ended';

interface WebphoneContextValue {
  extensionId: string | null;
  registration: RegistrationState;
  callState: CallState;
  remoteIdentity: string | null;
  /** Perna da chamada a entrar (cabeçalho X-Falai-Leg-Id) — para gravar o motivo de uma recusa. */
  incomingLegId: string | null;
  /** Segundos que a chamada a entrar esperou na fila (X-Falai-Queue-Wait); null = não veio da fila. */
  incomingQueueWaitSecs: number | null;
  error: string | null;
  /** Esta sessão é uma supervisão (o utilizador é o supervisor a ouvir). */
  supervising: boolean;
  /** Um supervisor está nesta chamada do agente (null = ninguém, ou Escuta sem aviso). */
  supervisedMode: SupervisionMode | null;
  selectExtension: (extensionId: string) => Promise<void>;
  unregister: () => void;
  call: (number: string) => void;
  answer: () => void;
  hangup: () => void;
  /** Recusa a chamada a entrar com 603 Decline — conta como recusa nos relatórios. */
  reject: () => void;
  mute: () => void;
  unmute: () => void;
  sendDTMF: (digit: string) => void;
}

const WebphoneContext = createContext<WebphoneContextValue | null>(null);

export function WebphoneProvider({ children }: { children: ReactNode }) {
  const { info, error: toastError } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location.pathname);
  locationRef.current = location.pathname;

  const uaRef = useRef<JsSIPType.UA | null>(null);
  const sessionRef = useRef<RTCSession | null>(null);
  // A chamada a entrar vai ser atendida sozinha (X-Falai-Auto-Answer): não toca.
  const autoAnsweringRef = useRef(false);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const [extensionId, setExtensionId] = useState<string | null>(null);
  const [registration, setRegistration] = useState<RegistrationState>('unregistered');
  const [callState, setCallState] = useState<CallState>('idle');
  const [remoteIdentity, setRemoteIdentity] = useState<string | null>(null);
  const [incomingLegId, setIncomingLegId] = useState<string | null>(null);
  const [incomingQueueWaitSecs, setIncomingQueueWaitSecs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supervising, setSupervising] = useState(false);
  const [supervisedMode, setSupervisedMode] = useState<SupervisionMode | null>(null);

  // <audio> escondido para tocar o stream remoto — não há UI própria disso.
  // O Safari do iOS só o toca se estiver na página, com playsinline, e se o
  // play() tiver sido autorizado por um gesto (ver unlockRemoteAudio): sem
  // isto o agente no iPhone fala mas não ouve o cliente.
  useEffect(() => {
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.style.display = 'none';
    document.body.appendChild(audio);
    remoteAudioRef.current = audio;
    return () => {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    };
  }, []);

  // Chamado dentro de um clique (escolher a linha, marcar, atender): o iOS
  // passa a deixar este elemento tocar mais tarde, quando o áudio chegar.
  const unlockRemoteAudio = useCallback(() => {
    void remoteAudioRef.current?.play().catch(() => {});
  }, []);

  const playRemoteStream = useCallback((stream: MediaStream) => {
    const audio = remoteAudioRef.current;
    if (!audio) return;
    if (audio.srcObject !== stream) audio.srcObject = stream;
    void audio.play().catch(() => {});
  }, []);

  const teardownUa = useCallback(() => {
    sessionRef.current = null;
    uaRef.current?.stop();
    uaRef.current = null;
    setRegistration('unregistered');
    setCallState('idle');
    setRemoteIdentity(null);
  }, []);

  const attachSession = useCallback(
    (session: RTCSession, initialState: CallState) => {
      sessionRef.current = session;
      setCallState(initialState);
      setRemoteIdentity(session.remote_identity?.uri?.user ?? null);
      setIncomingLegId(null);

      // O áudio remoto liga-se assim que a faixa chega (evento 'track'), e não
      // só no 'confirmed': no Safari a faixa pode chegar antes ou depois.
      const watchTracks = (pc: RTCPeerConnection) =>
        pc.addEventListener('track', (ev) => playRemoteStream(ev.streams[0] ?? new MediaStream([ev.track])));
      if (session.connection) watchTracks(session.connection);
      else session.on('peerconnection', ({ peerconnection }) => watchTracks(peerconnection));

      session.on('progress', () => setCallState((s) => (s === 'incoming' ? s : 'ringing')));
      session.on('accepted', () => setCallState('in-call'));
      session.on('confirmed', () => {
        setCallState('in-call');
        const remoteStream = new MediaStream();
        const pc = session.connection;
        pc?.getReceivers().forEach((r) => r.track && remoteStream.addTrack(r.track));
        const current = remoteAudioRef.current?.srcObject;
        if (!(current instanceof MediaStream) || current.getAudioTracks().length === 0) playRemoteStream(remoteStream);
        else void remoteAudioRef.current?.play().catch(() => {});
      });
      // Só a sessão corrente mexe no estado: o fim de uma sessão antiga não
      // pode largar a referência da chamada em curso (ficava impossível desligar).
      session.on('ended', () => {
        if (sessionRef.current !== session) return;
        setCallState('ended');
        sessionRef.current = null;
        setTimeout(() => setCallState((s) => (s === 'ended' ? 'idle' : s)), 1500);
      });
      session.on('failed', (e) => {
        if (sessionRef.current !== session) return;
        setError(e.cause ?? 'Chamada falhou');
        setCallState('ended');
        sessionRef.current = null;
        setTimeout(() => setCallState((s) => (s === 'ended' ? 'idle' : s)), 1500);
      });
    },
    [playRemoteStream],
  );

  const selectExtension = useCallback(
    async (id: string) => {
      unlockRingtone(); // gesto do utilizador: autoriza o toque para depois
      unlockRemoteAudio();
      teardownUa();
      setError(null);
      setExtensionId(id);
      setRegistration('registering');

      try {
        const [JsSIP, creds] = await Promise.all([
          import('jssip'),
          webphoneApi.getCredentials(id),
        ]);
        const ua = new JsSIP.UA({
          sockets: [new JsSIP.WebSocketInterface(creds.wsUri)],
          uri: `sip:${creds.sipUser}@${creds.sipDomain}`,
          authorization_user: creds.sipAuthUser,
          password: creds.sipAuthSecret,
          display_name: creds.displayName ?? creds.number,
          register: true,
        });

        ua.on('registered', () => setRegistration('registered'));
        ua.on('unregistered', () => setRegistration('unregistered'));
        ua.on('registrationFailed', (e) => {
          setRegistration('failed');
          setError(e.cause ?? 'Falha no registo SIP');
        });

        ua.on('newRTCSession', ({ session, originator, request }: RTCSessionEvent) => {
          if (originator !== 'remote') return;
          // Já em chamada: 486 (o router conta-o como BUSY). Sem isto a sessão
          // nova substituía a corrente e o botão Desligar deixava de a alcançar.
          if (sessionRef.current) {
            session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
            return;
          }
          // Supervisão (melhoria 4): a API liga para a extensão do supervisor
          // com X-Falai-Supervise — atende-se sozinha, sem toque nem painel.
          if (request.getHeader('X-Falai-Supervise')) {
            attachSession(session, 'in-call');
            setSupervising(true);
            session.on('ended', () => setSupervising(false));
            session.on('failed', () => setSupervising(false));
            session.answer({ mediaConstraints: { audio: true, video: false } });
            return;
          }
          // Chamada de entrada — se o agente não estiver na página do
          // webphone, o único aviso é este toast (a sessão continua viva no
          // Context, mas sem UI própria aqui para atender).
          // Extensão com atendimento automático (definido pelo administrador,
          // inboundCallRouter.service.ts): sem toque, um bip e entra sozinha.
          const autoAnswer = request.getHeader('X-Falai-Auto-Answer') === '1';
          autoAnsweringRef.current = autoAnswer;
          attachSession(session, 'incoming');
          // Posto pelo router de entrada (inboundCallRouter.service.ts) para
          // o motivo de uma recusa ficar na perna certa dos relatórios.
          setIncomingLegId(request.getHeader('X-Falai-Leg-Id') || null);
          // Vem da fila de espera: sinal próprio (bip + notificação do sistema),
          // mesmo com o CRM noutro separador.
          const waited = Number(request.getHeader('X-Falai-Queue-Wait')) || null;
          setIncomingQueueWaitSecs(waited);
          if (waited) {
            playQueueAlert();
            notifyQueueCall(session.remote_identity.uri.user, waited);
          }
          if (autoAnswer) {
            playAutoAnswerBeep();
            setTimeout(() => {
              if (sessionRef.current !== session || !session.isInProgress()) return;
              unlockRemoteAudio();
              session.answer({ mediaConstraints: { audio: true, video: false } });
            }, 500);
            if (locationRef.current !== '/webphone') {
              info('Chamada atendida automaticamente.');
              navigate('/webphone');
            }
            return;
          }
          if (locationRef.current !== '/webphone') {
            info(waited ? `Chamada da fila (esperou ${fmtWait(waited)}) — abra o Webphone para atender.` : 'Chamada a entrar — abra o Webphone para atender.');
          }
        });

        uaRef.current = ua;
        ua.start();
      } catch (err) {
        setRegistration('failed');
        setError(err instanceof Error ? err.message : 'Não foi possível obter as credenciais do webphone');
      }
    },
    [attachSession, info, navigate, teardownUa, unlockRemoteAudio],
  );

  const unregister = useCallback(() => {
    teardownUa();
    setExtensionId(null);
  }, [teardownUa]);

  const call = useCallback(
    (number: string) => {
      const ua = uaRef.current;
      if (!ua || registration !== 'registered') {
        toastError('O webphone ainda não está registado.');
        return;
      }
      setError(null);
      unlockRemoteAudio();
      const session = ua.call(number);
      attachSession(session, 'calling');
    },
    [attachSession, registration, toastError, unlockRemoteAudio],
  );

  const answer = useCallback(() => {
    unlockRemoteAudio();
    sessionRef.current?.answer({ mediaConstraints: { audio: true, video: false } });
  }, [unlockRemoteAudio]);

  const hangup = useCallback(() => {
    sessionRef.current?.terminate();
  }, []);

  // Sem status_code o JsSIP manda 480, que é igual a "ninguém atendeu".
  const reject = useCallback(() => {
    sessionRef.current?.terminate({ status_code: 603, reason_phrase: 'Decline' });
  }, []);

  const mute = useCallback(() => sessionRef.current?.mute({ audio: true }), []);
  const unmute = useCallback(() => sessionRef.current?.unmute({ audio: true }), []);
  const sendDTMF = useCallback((digit: string) => sessionRef.current?.sendDTMF(digit), []);

  useEffect(() => () => teardownUa(), [teardownUa]);

  // Aviso de supervisão para o agente (melhoria 4). O evento vem pelo SSE do
  // tenant (partilhado, lib/tenantEvents.ts) e só interessa à extensão escolhida aqui.
  useEffect(() => setSupervisedMode(null), [extensionId]);
  useTenantEvents<{ extensionId: string; mode: SupervisionMode | null }>(['supervision.agent'], (d) => {
    if (d.extensionId === extensionId) setSupervisedMode(d.mode);
  }, !!extensionId);
  // A supervisão acaba sempre com a chamada.
  useEffect(() => {
    if (callState === 'idle') setSupervisedMode(null);
  }, [callState]);

  // Toque no browser enquanto a chamada de entrada não é atendida/rejeitada.
  useEffect(() => {
    if (callState === 'incoming' && !autoAnsweringRef.current) startRingtone();
    else stopRingtone();
  }, [callState]);
  useEffect(() => stopRingtone, []);

  // Chamada de saída: sinal de chamada até o cliente atender (ou falhar). A
  // supervisão entra directamente em 'in-call', por isso não toca.
  useEffect(() => {
    if (callState === 'calling' || callState === 'ringing') startRingback();
    else stopRingback();
  }, [callState]);
  useEffect(() => stopRingback, []);

  // Com a página recarregada, o gesto de escolher a linha pode não voltar a
  // acontecer (linha reposta automaticamente): qualquer clique autoriza o som.
  useEffect(() => {
    window.addEventListener('pointerdown', unlockRingtone);
    window.addEventListener('keydown', unlockRingtone);
    return () => {
      window.removeEventListener('pointerdown', unlockRingtone);
      window.removeEventListener('keydown', unlockRingtone);
    };
  }, []);

  // Se uma chamada de entrada tocar noutra página, dar um atalho fácil ao
  // agente para a ir atender sem ter de navegar manualmente.
  useEffect(() => {
    if (callState === 'incoming' && locationRef.current !== '/webphone') {
      const id = setTimeout(() => {
        if (sessionRef.current && callState === 'incoming') navigate('/webphone');
      }, 6000);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [callState, navigate]);

  return (
    <WebphoneContext.Provider
      value={{
        extensionId,
        registration,
        callState,
        remoteIdentity,
        incomingLegId,
        incomingQueueWaitSecs,
        supervising,
        supervisedMode,
        error,
        selectExtension,
        unregister,
        call,
        answer,
        hangup,
        reject,
        mute,
        unmute,
        sendDTMF,
      }}
    >
      {children}
    </WebphoneContext.Provider>
  );
}

const fmtWait = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Notificação do sistema operativo; pede autorização na primeira vez. */
function notifyQueueCall(from: string, waited: number): void {
  if (typeof Notification === 'undefined') return;
  const show = () => new Notification('Chamada da fila a entrar', { body: `${from} — esperou ${fmtWait(waited)}`, tag: 'falai-queue-call' });
  if (Notification.permission === 'granted') show();
  else if (Notification.permission === 'default') void Notification.requestPermission().then((p) => p === 'granted' && show());
}

export function useWebphone(): WebphoneContextValue {
  const ctx = useContext(WebphoneContext);
  if (!ctx) throw new Error('useWebphone deve ser usado dentro de WebphoneProvider');
  return ctx;
}
