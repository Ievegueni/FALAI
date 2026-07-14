import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { AuthProvider } from '@/contexts/AuthContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { AppLayout, AuthLayout } from '@/components/layout/AppLayout';

import { LoginPage } from '@/pages/auth/LoginPage';
import { RegisterPage } from '@/pages/auth/RegisterPage';
import { TwoFactorPage } from '@/pages/auth/TwoFactorPage';
import { OnboardingPage } from '@/pages/onboarding/OnboardingPage';
import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { AgentsPage } from '@/pages/agents/AgentsPage';
import { AgentFormPage } from '@/pages/agents/AgentFormPage';
import { SimulatorPage } from '@/pages/agents/SimulatorPage';
import { ContactsPage } from '@/pages/contacts/ContactsPage';
import { ImportPage } from '@/pages/contacts/ImportPage';
import { CallsPage } from '@/pages/calls/CallsPage';
import { NewCallPage } from '@/pages/calls/NewCallPage';
import { DirectCallPage } from '@/pages/calls/DirectCallPage';
import { CallDetailPage } from '@/pages/calls/CallDetailPage';
import { CampaignsPage } from '@/pages/campaigns/CampaignsPage';
import { CampaignFormPage } from '@/pages/campaigns/CampaignFormPage';
import { CampaignDetailPage } from '@/pages/campaigns/CampaignDetailPage';
import { WalletPage } from '@/pages/wallet/WalletPage';
import { TeamPage } from '@/pages/team/TeamPage';
import { DevelopersPage } from '@/pages/developers/DevelopersPage';
import { SettingsPage } from '@/pages/settings/SettingsPage';
import { PbxIntegrationPage } from '@/pages/settings/PbxIntegrationPage';

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              {/* Public auth routes */}
              <Route element={<AuthLayout />}>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/2fa" element={<TwoFactorPage />} />
              </Route>

              {/* Onboarding — full-page, no sidebar */}
              <Route path="/onboarding" element={<OnboardingPage />} />

              {/* Protected app routes */}
              <Route element={<AppLayout />}>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />

                <Route path="/agents" element={<AgentsPage />} />
                <Route path="/agents/new" element={<AgentFormPage />} />
                <Route path="/agents/:id" element={<AgentFormPage />} />
                <Route path="/agents/:id/simulate" element={<SimulatorPage />} />

                <Route path="/contacts" element={<ContactsPage />} />
                <Route path="/contacts/import" element={<ImportPage />} />

                <Route path="/calls" element={<CallsPage />} />
                <Route path="/calls/new" element={<NewCallPage />} />
                <Route path="/calls/direct" element={<DirectCallPage />} />
                <Route path="/calls/:id" element={<CallDetailPage />} />

                <Route path="/campaigns" element={<CampaignsPage />} />
                <Route path="/campaigns/new" element={<CampaignFormPage />} />
                <Route path="/campaigns/:id" element={<CampaignDetailPage />} />

                <Route path="/wallet" element={<WalletPage />} />
                <Route path="/team" element={<TeamPage />} />
                <Route path="/developers" element={<DevelopersPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/pbx" element={<PbxIntegrationPage />} />
              </Route>

              {/* Fallback */}
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
