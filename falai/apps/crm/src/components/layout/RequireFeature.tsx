import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import type { FeatureKey } from '@/types';
import { canSeeDashboard, useNavItems } from './nav';

/**
 * Bloqueia o acesso a uma rota quando a funcionalidade correspondente
 * está desactivada para o tenant (definido no backoffice).
 * Se o backend não devolver features, assume-se activo (retrocompatível).
 */
export function RequireFeature({ feature, children }: { feature: FeatureKey; children: ReactNode }) {
  const { tenant } = useAuth();
  const enabled = tenant?.features?.[feature] !== false;
  if (!enabled) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

/**
 * O Dashboard é a página de entrada, mas o perfil de acesso pode tirá-lo.
 * Nesse caso vai para o primeiro módulo do menu (as outras rotas bloqueadas
 * mandam para /dashboard e acabam aqui também).
 */
export function RequireDashboard({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const nav = useNavItems();
  if (!canSeeDashboard(user)) return <Navigate to={nav[0]?.to ?? '/settings'} replace />;
  return <>{children}</>;
}
