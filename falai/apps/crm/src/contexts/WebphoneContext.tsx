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
import { startRingtone, stopRingtone, unlockRingtone } from '@/lib/ringtone';
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
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const [extensionId, setExtensionId] = useState<string | null>(null);
  const [registration, setRegistration] = useState<RegistrationState>('unregistered');
  const [callState, setCallState] = useState<CallState>('idle');
  const [remoteIdentity, setRemoteIdentity] = useState<string | null>(null);
  const [incomingLegId, setIncomingLegId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supervising, setSupervising] = useState(false);
  const [supervisedMode, setSupervisedMode] = useState<SupervisionMode | null>(null);

  // <audio> escondido para tocar o stream remoto — não há UI própria disso.
  useEffect(() => {
    const audio = new Audio();
    audio.autoplay = true;
    remoteAudioRef.current = audio;
    return () => {
      audio.pause();
      audio.srcObject = null;
    };
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

      session.on('progress', () => setCallState((s) => (s === 'incoming' ? s : 'ringing')));
      session.on('accepted', () => setCallState('in-call'));
      session.on('confirmed', () => {
        setCallState('in-call');
        const remoteStream = new MediaStream();
        const pc = session.connection;
        pc?.getReceivers().forEach((r) => r.track && remoteStream.addTrack(r.track));
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = remoteStream;
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
    [],
  );

  const selectExtension = useCallback(
    async (id: string) => {
      unlockRingtone(); // gesto do utilizador: autoriza o toque para depois
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
          attachSession(session, 'incoming');
          // Posto pelo router de entrada (inboundCallRouter.service.ts) para
          // o motivo de uma recusa ficar na perna certa dos relatórios.
          setIncomingLegId(request.getHeader('X-Falai-Leg-Id') || null);
          if (locationRef.current !== '/webphone') {
            info('Chamada a entrar — abra o Webphone para atender.');
          }
        });

        uaRef.current = ua;
        ua.start();
      } catch (err) {
        setRegistration('failed');
        setError(err instanceof Error ? err.message : 'Não foi possível obter as credenciais do webphone');
      }
    },
    [attachSession, info, teardownUa],
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
      const session = ua.call(number);
      attachSession(session, 'calling');
    },
    [attachSession, registration, toastError],
  );

  const answer = useCallback(() => {
    sessionRef.current?.answer({ mediaConstraints: { audio: true, video: false } });
  }, []);

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
    if (callState === 'incoming') startRingtone();
    else stopRingtone();
  }, [callState]);
  useEffect(() => stopRingtone, []);

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

export function useWebphone(): WebphoneContextValue {
  const ctx = useContext(WebphoneContext);
  if (!ctx) throw new Error('useWebphone deve ser usado dentro de WebphoneProvider');
  return ctx;
}
