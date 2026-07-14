import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { authApi } from '@/lib/api';
import type { Tenant, TenantUser } from '@/types';

interface AuthState {
  user: TenantUser | null;
  tenant: Tenant | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<{ requiresTwoFactor: boolean }>;
  verify2fa: (code: string) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, tenant: null, loading: true });

  const refreshMe = useCallback(async () => {
    const token = localStorage.getItem('falai_token');
    if (!token) {
      setState({ user: null, tenant: null, loading: false });
      return;
    }
    try {
      const { user, tenant } = await authApi.me();
      setState({ user, tenant, loading: false });
    } catch {
      localStorage.removeItem('falai_token');
      setState({ user: null, tenant: null, loading: false });
    }
  }, []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  useEffect(() => {
    const handler = () => {
      setState({ user: null, tenant: null, loading: false });
    };
    window.addEventListener('falai:unauthorized', handler);
    return () => window.removeEventListener('falai:unauthorized', handler);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    if (!res.requiresTwoFactor) {
      localStorage.setItem('falai_token', res.token);
      setState({ user: res.user, tenant: res.tenant, loading: false });
    } else {
      // store temp token for 2FA step
      sessionStorage.setItem('falai_temp_token', res.token);
    }
    return { requiresTwoFactor: res.requiresTwoFactor };
  }, []);

  const verify2fa = useCallback(async (code: string) => {
    const sessionToken = sessionStorage.getItem('falai_temp_token');
    if (!sessionToken) throw new Error('Sessão expirada');
    // The sessionToken (from /login) identifies the pending 2FA login.
    const { token } = await authApi.twoFaVerify(sessionToken, code);
    sessionStorage.removeItem('falai_temp_token');
    localStorage.setItem('falai_token', token);
    await refreshMe();
  }, [refreshMe]);

  const logout = useCallback(() => {
    localStorage.removeItem('falai_token');
    sessionStorage.removeItem('falai_temp_token');
    setState({ user: null, tenant: null, loading: false });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, verify2fa, logout, refreshMe }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
