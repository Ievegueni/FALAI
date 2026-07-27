import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { AuthProvider } from '@/contexts/AuthContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { AppLayout, AuthLayout } from '@/components/layout/AppLayout';
import { RequireFeature } from '@/components/layout/RequireFeature';

import { LoginPage } from '@/pages/auth/LoginPage';
import { TwoFactorPage } from '@/pages/auth/TwoFactorPage';
import { OnboardingPage } from '@/pages/onboarding/OnboardingPage';
import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { AgentsPage } from '@/pages/agents/AgentsPage';
import { AgentFormPage } from '@/pages/agents/AgentFormPage';
import { SimulatorPage } from '@/pages/agents/SimulatorPage';
import { ContactsPage } from '@/pages/contacts/ContactsPage';
import { ContactDetailPage } from '@/pages/contacts/ContactDetailPage';
import { ImportPage } from '@/pages/contacts/ImportPage';
import { CallsPage } from '@/pages/calls/CallsPage';
import { NewCallPage } from '@/pages/calls/NewCallPage';
import { DirectCallPage } from '@/pages/calls/DirectCallPage';
import { CallDetailPage } from '@/pages/calls/CallDetailPage';
import { ReportsPage } from '@/pages/reports/ReportsPage';
import { SmsPage } from '@/pages/sms/SmsPage';
import { CampaignsPage } from '@/pages/campaigns/CampaignsPage';
import { CampaignFormPage } from '@/pages/campaigns/CampaignFormPage';
import { CampaignDetailPage } from '@/pages/campaigns/CampaignDetailPage';
import { WalletPage } from '@/pages/wallet/WalletPage';
import { TeamPage } from '@/pages/team/TeamPage';
import { DevelopersPage } from '@/pages/developers/DevelopersPage';
import { SettingsPage } from '@/pages/settings/SettingsPage';
import { PbxIntegrationPage } from '@/pages/settings/PbxIntegrationPage';
import { TelephonyPage } from '@/pages/telephony/TelephonyPage';

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
                <Route path="/2fa" element={<TwoFactorPage />} />
              </Route>

              {/* Onboarding — full-page, no sidebar */}
              <Route path="/onboarding" element={<OnboardingPage />} />

              {/* Protected app routes */}
              <Route element={<AppLayout />}>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />

                <Route path="/agents" element={<RequireFeature feature="agents"><AgentsPage /></RequireFeature>} />
                <Route path="/agents/new" element={<RequireFeature feature="agents"><AgentFormPage /></RequireFeature>} />
                <Route path="/agents/:id" element={<RequireFeature feature="agents"><AgentFormPage /></RequireFeature>} />
                <Route path="/agents/:id/simulate" element={<RequireFeature feature="agents"><SimulatorPage /></RequireFeature>} />

                <Route path="/contacts" element={<RequireFeature feature="contacts"><ContactsPage /></RequireFeature>} />
                <Route path="/contacts/import" element={<RequireFeature feature="contacts"><ImportPage /></RequireFeature>} />
                <Route path="/contacts/:id" element={<RequireFeature feature="contacts"><ContactDetailPage /></RequireFeature>} />

                <Route path="/calls" element={<RequireFeature feature="calls"><CallsPage /></RequireFeature>} />
                <Route path="/calls/new" element={<RequireFeature feature="agents"><NewCallPage /></RequireFeature>} />
                <Route path="/calls/direct" element={<RequireFeature feature="directCall"><DirectCallPage /></RequireFeature>} />
                <Route path="/calls/:id" element={<RequireFeature feature="calls"><CallDetailPage /></RequireFeature>} />

                <Route path="/reports" element={<RequireFeature feature="calls"><ReportsPage /></RequireFeature>} />

                <Route path="/sms" element={<SmsPage />} />

                <Route path="/campaigns" element={<RequireFeature feature="campaigns"><CampaignsPage /></RequireFeature>} />
                <Route path="/campaigns/new" element={<RequireFeature feature="campaigns"><CampaignFormPage /></RequireFeature>} />
                <Route path="/campaigns/:id" element={<RequireFeature feature="campaigns"><CampaignDetailPage /></RequireFeature>} />

                <Route path="/wallet" element={<RequireFeature feature="wallet"><WalletPage /></RequireFeature>} />
                <Route path="/team" element={<RequireFeature feature="team"><TeamPage /></RequireFeature>} />
                <Route path="/developers" element={<RequireFeature feature="developers"><DevelopersPage /></RequireFeature>} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/pbx" element={<PbxIntegrationPage />} />
                <Route path="/telephony" element={<TelephonyPage />} />
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
