import { NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LogOut } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { clsx } from '@/lib/utils';
import { useNavItems, useProfileLabel } from './nav';

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { user, tenant, logout } = useAuth();
  const navigate = useNavigate();
  const nav = useNavItems();
  const profileLabel = useProfileLabel();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <>
    {open && <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={onClose} />}
    <aside
      className={clsx(
        'flex h-full w-60 flex-col bg-slate-900 text-slate-100 fixed left-0 top-0 z-40 transition-transform lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-slate-700/60">
        <div className="flex items-center justify-center rounded-lg bg-white px-2 py-1.5">
          <img
            src={tenant?.logoDataUrl ?? '/logo.png'}
            alt={tenant?.logoDataUrl ? tenant.name : 'Comunica'}
            className="h-5 w-auto max-w-[96px] object-contain"
          />
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
        {/* No telemóvel o cabeçalho esconde o utilizador; mostra-se aqui */}
        <div className="mb-2 flex items-center gap-2.5 px-3 py-1 lg:hidden">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-700">
            {user?.name.charAt(0).toUpperCase() ?? '?'}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">{user?.name}</p>
            <p className="truncate text-xs text-slate-400">{profileLabel}</p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
        >
          <LogOut className="h-4 w-4" />
          {t('nav.logout')}
        </button>
      </div>
    </aside>
    </>
  );
}
