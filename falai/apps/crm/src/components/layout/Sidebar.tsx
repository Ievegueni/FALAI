import { NavLink, useNavigate } from 'react-router-dom';
import { ChatUnreadBadge } from '@/components/chat/ChatBits';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { LogOut, Pin, PinOff } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { clsx } from '@/lib/utils';
import { useNavItems, useProfileLabel } from './nav';

interface Props {
  open: boolean; // gaveta no telemóvel
  onClose: () => void;
  pinned: boolean; // ecrã grande: fixada aberta
  onTogglePin: () => void;
}

export function Sidebar({ open, onClose, pinned, onTogglePin }: Props) {
  const [hover, setHover] = useState(false);
  // No telemóvel só se vê aberta (gaveta), por isso aí está sempre larga
  const wide = pinned || hover || open;
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
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={clsx(
        'flex h-full flex-col overflow-hidden bg-slate-900 text-slate-100 fixed left-0 top-0 z-40 transition-[transform,width] duration-200 lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
        wide ? 'w-60' : 'w-16',
        hover && !pinned && 'lg:shadow-2xl',
      )}
    >
      {/* Logo */}
      <div className={clsx('flex items-center gap-2.5 py-5 border-b border-slate-700/60', wide ? 'px-5' : 'px-2 justify-center')}>
        <div className="flex shrink-0 items-center justify-center rounded-lg bg-white px-2 py-1.5">
          <img
            src={tenant?.logoDataUrl ?? '/logo.png'}
            alt={tenant?.logoDataUrl ? tenant.name : 'Comunica'}
            className={clsx('h-5 w-auto object-contain', wide ? 'max-w-[96px]' : 'max-w-[28px]')}
          />
        </div>
        <div className={clsx('min-w-0 flex-1', !wide && 'hidden')}>
          <p className="text-sm font-bold text-white leading-none">Falaí</p>
          <p className="text-xs text-slate-400 leading-none mt-0.5 truncate max-w-[120px]">
            {tenant?.name ?? '…'}
          </p>
        </div>
        {wide && (
          <button
            onClick={onTogglePin}
            title={pinned ? t('nav.unpin') : t('nav.pin')}
            aria-label={pinned ? t('nav.unpin') : t('nav.pin')}
            className={clsx(
              'hidden shrink-0 rounded-md p-1.5 transition-colors lg:block',
              pinned ? 'text-blue-400 hover:bg-slate-800' : 'text-slate-400 hover:bg-slate-800 hover:text-white',
            )}
          >
            {pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        <ul className="space-y-0.5">
          {nav.map(({ to, icon: Icon, labelKey }) => (
            <li key={to}>
              <NavLink
                to={to}
                title={wide ? undefined : t(labelKey)}
                className={({ isActive }) =>
                  clsx(
                    'relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white',
                  )
                }
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                {wide && <span className="truncate">{t(labelKey)}</span>}
                {to === '/chat' && <ChatUnreadBadge wide={wide} />}
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
          title={wide ? undefined : t('nav.logout')}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
        >
          <LogOut className="h-4 w-4 flex-shrink-0" />
          {wide && <span className="truncate">{t('nav.logout')}</span>}
        </button>
      </div>
    </aside>
    </>
  );
}
