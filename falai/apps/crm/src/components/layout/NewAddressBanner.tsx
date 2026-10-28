import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Quem ainda entra pelo endereço geral (falai.comunica.ao) quando o cliente
 * já tem endereço próprio (credito.falai.ao) vê o novo endereço. A sessão não
 * passa de um endereço para o outro (fica no localStorage de cada um), por
 * isso no novo é preciso entrar outra vez.
 */
export function NewAddressBanner() {
  const { t } = useTranslation();
  const { tenant } = useAuth();
  if (!tenant?.crmUrl) return null;
  let host: string;
  try {
    host = new URL(tenant.crmUrl).host;
  } catch {
    return null;
  }
  if (host === window.location.host) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-indigo-200 bg-indigo-50 px-4 py-2 text-sm text-indigo-900" role="status">
      <span>{t('newAddress.text', { url: host })}</span>
      <a href={tenant.crmUrl} className="inline-flex items-center gap-1 font-medium underline">
        {t('newAddress.go')} <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}
