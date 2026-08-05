import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { AuthProvider } from '@/contexts/AuthContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { WebphoneProvider } from '@/contexts/WebphoneContext';
import { AppLayout, AuthLayout } from '@/components/layout/AppLayout';
import { RequireFeature } from '@/components/layout/RequireFeature';
import { PageSpinner } from '@/components/ui/Spinner';

// Só o login entra no bundle de arranque — é a única página garantidamente
// vista por todos. As restantes são pedidas à medida que se navega; sem isto,
// abrir o login trazia também os gráficos (recharts), o webphone e o resto da
// aplicação. O Dashboard é carregado à parte pela mesma razão: os gráficos
// pesam mais do que o salto extra, e o pedido sai em paralelo com o /me.
import { LoginPage } from '@/pages/auth/LoginPage';

const DashboardPage = lazy(() => import('@/pages/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const TwoFactorPage = lazy(() => import('@/pages/auth/TwoFactorPage').then((m) => ({ default: m.TwoFactorPage })));
const OnboardingPage = lazy(() => import('@/pages/onboarding/OnboardingPage').then((m) => ({ default: m.OnboardingPage })));
const AgentsPage = lazy(() => import('@/pages/agents/AgentsPage').then((m) => ({ default: m.AgentsPage })));
const AgentFormPage = lazy(() => import('@/pages/agents/AgentFormPage').then((m) => ({ default: m.AgentFormPage })));
const SimulatorPage = lazy(() => import('@/pages/agents/SimulatorPage').then((m) => ({ default: m.SimulatorPage })));
const ContactsPage = lazy(() => import('@/pages/contacts/ContactsPage').then((m) => ({ default: m.ContactsPage })));
const ContactDetailPage = lazy(() => import('@/pages/contacts/ContactDetailPage').then((m) => ({ default: m.ContactDetailPage })));
const ImportPage = lazy(() => import('@/pages/contacts/ImportPage').then((m) => ({ default: m.ImportPage })));
const CallsPage = lazy(() => import('@/pages/calls/CallsPage').then((m) => ({ default: m.CallsPage })));
const NewCallPage = lazy(() => import('@/pages/calls/NewCallPage').then((m) => ({ default: m.NewCallPage })));
const DirectCallPage = lazy(() => import('@/pages/calls/DirectCallPage').then((m) => ({ default: m.DirectCallPage })));
const CallDetailPage = lazy(() => import('@/pages/calls/CallDetailPage').then((m) => ({ default: m.CallDetailPage })));
const ReportsPage = lazy(() => import('@/pages/reports/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const SmsPage = lazy(() => import('@/pages/sms/SmsPage').then((m) => ({ default: m.SmsPage })));
const CampaignsPage = lazy(() => import('@/pages/campaigns/CampaignsPage').then((m) => ({ default: m.CampaignsPage })));
const CampaignFormPage = lazy(() => import('@/pages/campaigns/CampaignFormPage').then((m) => ({ default: m.CampaignFormPage })));
const CampaignDetailPage = lazy(() => import('@/pages/campaigns/CampaignDetailPage').then((m) => ({ default: m.CampaignDetailPage })));
const WalletPage = lazy(() => import('@/pages/wallet/WalletPage').then((m) => ({ default: m.WalletPage })));
const TeamPage = lazy(() => import('@/pages/team/TeamPage').then((m) => ({ default: m.TeamPage })));
const DevelopersPage = lazy(() => import('@/pages/developers/DevelopersPage').then((m) => ({ default: m.DevelopersPage })));
const SettingsPage = lazy(() => import('@/pages/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const PbxIntegrationPage = lazy(() => import('@/pages/settings/PbxIntegrationPage').then((m) => ({ default: m.PbxIntegrationPage })));
const TelephonyPage = lazy(() => import('@/pages/telephony/TelephonyPage').then((m) => ({ default: m.TelephonyPage })));
const WebphonePage = lazy(() => import('@/pages/calls/WebphonePage').then((m) => ({ default: m.WebphonePage })));

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <BrowserRouter>
            <WebphoneProvider>
            <Suspense fallback={<PageSpinner />}>
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
                <Route path="/webphone" element={<RequireFeature feature="webphone"><WebphonePage /></RequireFeature>} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/pbx" element={<PbxIntegrationPage />} />
                <Route path="/telephony" element={<TelephonyPage />} />
              </Route>

              {/* Fallback */}
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
            </Suspense>
            </WebphoneProvider>
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
