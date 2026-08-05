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
import { webphoneApi } from '@/lib/api';
import { useToast } from '@/contexts/ToastContext';

export type RegistrationState = 'unregistered' | 'registering' | 'registered' | 'failed';
export type CallState = 'idle' | 'calling' | 'ringing' | 'incoming' | 'in-call' | 'ended';

interface WebphoneContextValue {
  extensionId: string | null;
  registration: RegistrationState;
  callState: CallState;
  remoteIdentity: string | null;
  error: string | null;
  selectExtension: (extensionId: string) => Promise<void>;
  unregister: () => void;
  call: (number: string) => void;
  answer: () => void;
  hangup: () => void;
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
  const [error, setError] = useState<string | null>(null);

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

      session.on('progress', () => setCallState((s) => (s === 'incoming' ? s : 'ringing')));
      session.on('accepted', () => setCallState('in-call'));
      session.on('confirmed', () => {
        setCallState('in-call');
        const remoteStream = new MediaStream();
        const pc = session.connection;
        pc?.getReceivers().forEach((r) => r.track && remoteStream.addTrack(r.track));
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = remoteStream;
      });
      session.on('ended', () => {
        setCallState('ended');
        sessionRef.current = null;
        setTimeout(() => setCallState((s) => (s === 'ended' ? 'idle' : s)), 1500);
      });
      session.on('failed', (e) => {
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
          uri: `sip:${creds.sipAuthUser}@${creds.sipDomain}`,
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

        ua.on('newRTCSession', ({ session, originator }: RTCSessionEvent) => {
          if (originator !== 'remote') return;
          // Chamada de entrada — se o agente não estiver na página do
          // webphone, o único aviso é este toast (a sessão continua viva no
          // Context, mas sem UI própria aqui para atender).
          attachSession(session, 'incoming');
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

  const mute = useCallback(() => sessionRef.current?.mute({ audio: true }), []);
  const unmute = useCallback(() => sessionRef.current?.unmute({ audio: true }), []);
  const sendDTMF = useCallback((digit: string) => sessionRef.current?.sendDTMF(digit), []);

  useEffect(() => () => teardownUa(), [teardownUa]);

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
        error,
        selectExtension,
        unregister,
        call,
        answer,
        hangup,
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
