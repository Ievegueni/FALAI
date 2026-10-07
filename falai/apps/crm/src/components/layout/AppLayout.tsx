import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Sidebar } from './Sidebar';
import { PageSpinner } from '@/components/ui/Spinner';
import { LanguageSwitcher } from '@/components/ui/LanguageSwitcher';
import { IncomingCallBanner } from '@/components/calls/IncomingCallBanner';
import { AlertToaster } from '@/components/alerts/AlertToaster';
import { PlatformBanner } from './PlatformBanner';
import { ChatToaster } from '@/components/chat/ChatBits';

export function AppLayout() {
  const { user, loading, tenant } = useAuth();
  const { pathname } = useLocation();
  // Em ecrãs pequenos a sidebar é uma gaveta; fecha ao mudar de página
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [pathname]);
  // No ecrã grande a sidebar fica recolhida (só ícones) e abre ao passar o rato; fixada fica sempre aberta
  const [pinned, setPinned] = useState(() => {
    try { return localStorage.getItem('falai_sidebar_pinned') === '1'; } catch { return false; }
  });
  const togglePin = () => {
    setPinned((p) => {
      try { localStorage.setItem('falai_sidebar_pinned', p ? '0' : '1'); } catch { /* sem storage: só nesta sessão */ }
      return !p;
    });
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <PageSpinner />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="flex h-screen bg-gray-50">
      <IncomingCallBanner />
      <AlertToaster />
      <ChatToaster />
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} pinned={pinned} onTogglePin={togglePin} />
      <div className={`flex min-w-0 flex-1 flex-col transition-[margin] ${pinned ? 'lg:ml-60' : 'lg:ml-16'}`}>
        <div className="flex h-12 shrink-0 items-center gap-3 bg-slate-900 px-4 lg:hidden">
          <button
            onClick={() => setNavOpen(true)}
            className="-ml-1 rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
            aria-label="Menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <p className="truncate text-sm font-bold text-white">
            Falaí <span className="font-normal text-slate-400">· {tenant?.name ?? '…'}</span>
          </p>
        </div>
        <PlatformBanner />
        <div className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

export function AuthLayout() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <PageSpinner />
      </div>
    );
  }

  if (user) return <Navigate to="/dashboard" replace />;

  return (
    <div className="relative min-h-screen bg-gradient-to-br from-slate-900 to-blue-950 flex items-center justify-center p-4">
      <div className="absolute top-4 right-4 rounded-full bg-white/10 backdrop-blur">
        <LanguageSwitcher />
      </div>
      <Outlet />
    </div>
  );
}
