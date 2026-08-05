import { NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  Bot,
  Users,
  Phone,
  MessageSquare,
  Megaphone,
  BarChart3,
  Wallet,
  UserCheck,
  Code2,
  Settings,
  Server,
  Network,
  LogOut,
  PhoneCall,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { clsx } from '@/lib/utils';

import type { FeatureKey } from '@/types';

const dashboardItem = { to: '/dashboard', icon: LayoutDashboard, labelKey: 'nav.dashboard' };
// Cada item pode declarar a feature que o activa; sem feature = sempre visível
const featureItems: { to: string; icon: typeof Bot; labelKey: string; feature: FeatureKey }[] = [
  { to: '/agents', icon: Bot, labelKey: 'nav.agents', feature: 'agents' },
  { to: '/campaigns', icon: Megaphone, labelKey: 'nav.campaigns', feature: 'campaigns' },
  { to: '/contacts', icon: Users, labelKey: 'nav.contacts', feature: 'contacts' },
  { to: '/calls', icon: Phone, labelKey: 'nav.calls', feature: 'calls' },
  { to: '/webphone', icon: PhoneCall, labelKey: 'nav.webphone', feature: 'webphone' },
  { to: '/reports', icon: BarChart3, labelKey: 'nav.reports', feature: 'calls' },
  { to: '/wallet', icon: Wallet, labelKey: 'nav.wallet', feature: 'wallet' },
  { to: '/team', icon: UserCheck, labelKey: 'nav.team', feature: 'team' },
  { to: '/developers', icon: Code2, labelKey: 'nav.developers', feature: 'developers' },
];
const settingsItem = { to: '/settings', icon: Settings, labelKey: 'nav.settings' };
const smsItem = { to: '/sms', icon: MessageSquare, labelKey: 'nav.sms' };
const telephonyItem = { to: '/telephony', icon: Network, labelKey: 'nav.telephony' };

export function Sidebar() {
  const { t } = useTranslation();
  const { tenant, logout } = useAuth();
  const navigate = useNavigate();

  const features = tenant?.features;
  const ownPbx = tenant?.plan?.productType === 'CRM_BYO_PBX';

  // Mostra um item se a sua feature estiver activa (default: visível se não houver info de features)
  const isOn = (f: FeatureKey) => features?.[f] !== false;

  // SMS visível quando o plano o inclui (o backend valida à mesma no envio)
  const smsOn = tenant?.plan?.smsEnabled === true;

  const nav = [
    dashboardItem,
    ...featureItems.filter((i) => isOn(i.feature)),
    ...(smsOn ? [smsItem] : []),
    telephonyItem,
    settingsItem,
    ...(ownPbx ? [{ to: '/settings/pbx', icon: Server, labelKey: 'nav.pbx' }] : []),
  ];

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <aside className="flex h-screen w-60 flex-col bg-slate-900 text-slate-100 fixed left-0 top-0 z-30">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-slate-700/60">
        <div className="flex items-center justify-center rounded-lg bg-white px-2 py-1.5">
          <img src="/logo.png" alt="Comunica" className="h-5 w-auto" />
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
          {nav.map(({ to, icon: Icon, labelKey }) => (
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
                {t(labelKey)}
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
          {t('nav.logout')}
        </button>
      </div>
    </aside>
  );
}
