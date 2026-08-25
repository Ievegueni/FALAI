import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Building2,
  ShieldCheck,
  CreditCard,
  Settings,
  HeartPulse,
  BarChart3,
  ScrollText,
  Phone,
  Radio,
  Cpu,
} from 'lucide-react';
import { clsx } from '@/lib/utils';

const NAV = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/tenants', icon: Building2, label: 'Tenants' },
  { to: '/moderation', icon: ShieldCheck, label: 'Moderação' },
  { to: '/models', icon: Cpu, label: 'Modelos' },
  { to: '/calls', icon: Phone, label: 'Chamadas' },
  { to: '/trunks', icon: Radio, label: 'Trunks' },
  { to: '/finance', icon: BarChart3, label: 'Financeiro' },
  { to: '/plans', icon: CreditCard, label: 'Planos' },
  { to: '/health', icon: HeartPulse, label: 'Saúde' },
  { to: '/audit', icon: ScrollText, label: 'Audit' },
  { to: '/settings', icon: Settings, label: 'Configurações' },
];

export function Sidebar() {
  return (
    <aside className="flex h-full w-60 flex-col border-r border-gray-200 bg-slate-900">
      <div className="flex h-16 items-center gap-2.5 px-5 border-b border-slate-700">
        <div className="flex items-center justify-center rounded-lg bg-white px-2 py-1.5">
          <img src="/logo.png" alt="Comunica" className="h-5 w-auto" />
        </div>
        <div>
          <p className="text-sm font-bold text-white leading-none">Falaí</p>
          <p className="text-xs text-slate-400 leading-none mt-0.5">Backoffice</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-4 px-3">
        <ul className="flex flex-col gap-0.5">
          {NAV.map(({ to, icon: Icon, label }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white',
                  )
                }
              >
                <Icon className="h-5 w-5 flex-shrink-0" />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-slate-700 px-3 py-3">
        <p className="px-3 text-xs text-slate-500">COMUNICA internal</p>
      </div>
    </aside>
  );
}
