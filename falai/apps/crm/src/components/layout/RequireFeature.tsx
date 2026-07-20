import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import type { FeatureKey } from '@/types';

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
