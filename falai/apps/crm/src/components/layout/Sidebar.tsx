import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Bot,
  Users,
  Phone,
  Megaphone,
  Wallet,
  UserCheck,
  Code2,
  Settings,
  Server,
  LogOut,
  Zap,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { clsx } from '@/lib/utils';

const dashboardItem = { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' };
const aiItems = [
  { to: '/agents', icon: Bot, label: 'Agentes' },
  { to: '/campaigns', icon: Megaphone, label: 'Campanhas' },
];
const commonItems = [
  { to: '/contacts', icon: Users, label: 'Contactos' },
  { to: '/calls', icon: Phone, label: 'Chamadas' },
  { to: '/wallet', icon: Wallet, label: 'Carteira' },
  { to: '/team', icon: UserCheck, label: 'Equipa' },
  { to: '/developers', icon: Code2, label: 'Developers' },
  { to: '/settings', icon: Settings, label: 'Definições' },
];

export function Sidebar() {
  const { tenant, logout } = useAuth();
  const navigate = useNavigate();

  const aiEnabled = tenant?.plan?.aiAgentsEnabled !== false;
  const ownPbx = tenant?.plan?.productType === 'CRM_BYO_PBX';

  // Agentes/Campanhas só se o plano tiver IA; Integração PBX só para PBX próprio
  const nav = [
    dashboardItem,
    ...(aiEnabled ? aiItems : []),
    ...commonItems,
    ...(ownPbx ? [{ to: '/settings/pbx', icon: Server, label: 'Integração PBX' }] : []),
  ];

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <aside className="flex h-screen w-60 flex-col bg-slate-900 text-slate-100 fixed left-0 top-0 z-30">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-slate-700/60">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600">
          <Zap className="h-4 w-4 text-white" />
        </div>
        <div>
          <p className="text-sm font-bold text-white leading-none">Falaí</p>
          <p className="text-xs text-slate-400 leading-none mt-0.5 truncate max-w-[120px]">
            {tenant?.name ?? '…'}
          </p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        <ul className="space-y-0.5">
          {nav.map(({ to, icon: Icon, label }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white',
                  )
                }
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Footer */}
      <div className="border-t border-slate-700/60 p-3">
        <button
          onClick={handleLogout}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Terminar sessão
        </button>
      </div>
    </aside>
  );
}
