import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { authApi } from '@/lib/api';
import type { AdminUser } from '@/types';

interface AuthState { user: AdminUser | null; loading: boolean }

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<{ requiresTwoFactor: boolean }>;
  verify2fa: (code: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true });

  const refresh = useCallback(async () => {
    const token = localStorage.getItem('falai_admin_token');
    if (!token) { setState({ user: null, loading: false }); return; }
    try {
      const user = await authApi.me();
      setState({ user, loading: false });
    } catch {
      localStorage.removeItem('falai_admin_token');
      setState({ user: null, loading: false });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const handler = () => setState({ user: null, loading: false });
    window.addEventListener('falai:admin:unauthorized', handler);
    return () => window.removeEventListener('falai:admin:unauthorized', handler);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    if (!res.requiresTwoFactor) {
      localStorage.setItem('falai_admin_token', res.token);
      setState({ user: res.user, loading: false });
    } else {
      sessionStorage.setItem('falai_admin_temp', res.token);
    }
    return { requiresTwoFactor: res.requiresTwoFactor };
  }, []);

  const verify2fa = useCallback(async (code: string) => {
    const sessionToken = sessionStorage.getItem('falai_admin_temp');
    if (!sessionToken) throw new Error('Sessão expirada');
    const { token } = await authApi.twoFaVerify(sessionToken, code);
    sessionStorage.removeItem('falai_admin_temp');
    localStorage.setItem('falai_admin_token', token);
    await refresh();
  }, [refresh]);

  const logout = useCallback(() => {
    localStorage.removeItem('falai_admin_token');
    setState({ user: null, loading: false });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, verify2fa, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
