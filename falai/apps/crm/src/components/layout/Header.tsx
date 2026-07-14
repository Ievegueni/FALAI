import { Bell, Wallet } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { walletApi } from '@/lib/api';
import { formatAOA } from '@/lib/utils';

interface Props {
  title: string;
  actions?: React.ReactNode;
}

export function Header({ title, actions }: Props) {
  const { user } = useAuth();

  const { data: wallet } = useQuery({
    queryKey: ['wallet', 'balance'],
    queryFn: walletApi.balance,
    staleTime: 60_000,
  });

  const balanceLow =
    wallet !== undefined && wallet.balanceCents < 100_00; // < 100 Kz

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-gray-200 bg-white px-6">
      <h1 className="text-base font-semibold text-gray-900">{title}</h1>

      <div className="flex items-center gap-3">
        {wallet !== undefined && (
          <div
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${
              balanceLow
                ? 'bg-red-50 text-red-700 border border-red-200'
                : 'bg-gray-100 text-gray-700'
            }`}
          >
            <Wallet className="h-3.5 w-3.5" />
            {formatAOA(wallet.balanceCents)}
          </div>
        )}

        <button className="relative rounded-full p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors">
          <Bell className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-2 pl-3 border-l border-gray-200">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-blue-700 text-sm font-semibold">
            {user?.name.charAt(0).toUpperCase() ?? '?'}
          </div>
          <div className="hidden sm:block">
            <p className="text-xs font-medium text-gray-900 leading-none">{user?.name}</p>
            <p className="text-xs text-gray-400 leading-none mt-0.5">{user?.role}</p>
          </div>
        </div>

        {actions && <div className="flex items-center gap-2 pl-3 border-l border-gray-200">{actions}</div>}
      </div>
    </header>
  );
}
