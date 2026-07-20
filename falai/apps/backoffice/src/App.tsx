import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/contexts/AuthContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { queryClient } from '@/lib/queryClient';
import { AppLayout, AuthLayout } from '@/components/layout/AppLayout';
import { LoginPage } from '@/pages/auth/LoginPage';
import { TwoFactorPage } from '@/pages/auth/TwoFactorPage';
import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { TenantsPage } from '@/pages/tenants/TenantsPage';
import { TenantNewPage } from '@/pages/tenants/TenantNewPage';
import { TenantDetailPage } from '@/pages/tenants/TenantDetailPage';
import { ModerationPage } from '@/pages/moderation/ModerationPage';
import { PlansPage } from '@/pages/plans/PlansPage';
import { FinancePage } from '@/pages/finance/FinancePage';
import { HealthPage } from '@/pages/health/HealthPage';
import { AuditPage } from '@/pages/audit/AuditPage';
import { SettingsPage } from '@/pages/settings/SettingsPage';
import { CallsPage } from '@/pages/calls/CallsPage';
import { CallDetailPage } from '@/pages/calls/CallDetailPage';

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <Routes>
              {/* Auth */}
              <Route element={<AuthLayout />}>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/2fa" element={<TwoFactorPage />} />
              </Route>

              {/* App */}
              <Route element={<AppLayout />}>
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/tenants" element={<TenantsPage />} />
                <Route path="/tenants/new" element={<TenantNewPage />} />
                <Route path="/tenants/:id" element={<TenantDetailPage />} />
                <Route path="/moderation" element={<ModerationPage />} />
                <Route path="/calls" element={<CallsPage />} />
                <Route path="/calls/:id" element={<CallDetailPage />} />
                <Route path="/finance" element={<FinancePage />} />
                <Route path="/plans" element={<PlansPage />} />
                <Route path="/health" element={<HealthPage />} />
                <Route path="/audit" element={<AuditPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>

              {/* Default */}
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
