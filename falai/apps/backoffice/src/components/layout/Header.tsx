import { LogOut, User } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

const roleLabel: Record<string, string> = {
  SUPERADMIN: 'Super Admin',
  OPERATOR: 'Operador',
  FINANCE: 'Financeiro',
  SUPPORT: 'Suporte',
};

export function Header() {
  const { user, logout } = useAuth();

  return (
    <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
      <div />
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
          <User className="h-4 w-4" />
        </div>
        <div className="text-right">
          <p className="text-sm font-medium text-gray-900 leading-none">{user?.name ?? 'Admin'}</p>
          <p className="text-xs text-gray-500 mt-0.5">{user ? roleLabel[user.role] ?? user.role : ''}</p>
        </div>
        <button
          onClick={logout}
          className="ml-2 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          title="Sair"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
