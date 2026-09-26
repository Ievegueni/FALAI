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
  PhoneCall,
  Inbox,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import type { FeatureKey, TenantUser } from '@/types';

const dashboardItem = { to: '/dashboard', icon: LayoutDashboard, labelKey: 'nav.dashboard' };
const inboxItem = { to: '/inbox', icon: Inbox, labelKey: 'nav.inbox' };
// Cada item pode declarar a feature que o activa; sem feature = sempre visível
const featureItems: { to: string; icon: typeof Bot; labelKey: string; feature: FeatureKey }[] = [
  { to: '/agents', icon: Bot, labelKey: 'nav.agents', feature: 'agents' },
  { to: '/campaigns', icon: Megaphone, labelKey: 'nav.campaigns', feature: 'campaigns' },
  { to: '/contacts', icon: Users, labelKey: 'nav.contacts', feature: 'contacts' },
  { to: '/calls', icon: Phone, labelKey: 'nav.calls', feature: 'calls' },
  { to: '/webphone', icon: PhoneCall, labelKey: 'nav.webphone', feature: 'webphone' },
  { to: '/reports', icon: BarChart3, labelKey: 'nav.reports', feature: 'reports' },
  { to: '/wallet', icon: Wallet, labelKey: 'nav.wallet', feature: 'wallet' },
  { to: '/team', icon: UserCheck, labelKey: 'nav.team', feature: 'team' },
  { to: '/developers', icon: Code2, labelKey: 'nav.developers', feature: 'developers' },
];
const settingsItem = { to: '/settings', icon: Settings, labelKey: 'nav.settings' };
const smsItem = { to: '/sms', icon: MessageSquare, labelKey: 'nav.sms' };
const telephonyItem = { to: '/telephony', icon: Network, labelKey: 'nav.telephony' };

/** Itens do menu que o utilizador pode ver (features do tenant + perfil de acesso). */
export function useNavItems() {
  const { user, tenant } = useAuth();

  const features = tenant?.features;
  const ownPbx = tenant?.plan?.productType === 'CRM_BYO_PBX';

  // Mostra um item se a sua feature estiver activa (default: visível se não houver info de features)
  const isOn = (f: FeatureKey) => features?.[f] !== false;

  // SMS: a feature já vem desligada da API quando o plano não inclui SMS
  const smsOn = tenant?.plan?.smsEnabled === true && isOn('sms');

  return [
    ...(canSeeDashboard(user) ? [dashboardItem] : []),
    ...(features?.inbox ? [inboxItem] : []),
    ...featureItems.filter((i) => isOn(i.feature)),
    ...(smsOn ? [smsItem] : []),
    ...(isOn('telephony') ? [telephonyItem] : []),
    settingsItem,
    ...(ownPbx ? [{ to: '/settings/pbx', icon: Server, labelKey: 'nav.pbx' }] : []),
  ];
}

/** O perfil de acesso pode tirar o Dashboard (tem saldo e totais da conta). */
export function canSeeDashboard(user: TenantUser | null | undefined): boolean {
  return user?.accessProfile?.permissions?.dashboard !== 'none';
}

const ROLE_KEYS: Record<string, string> = {
  OWNER: 'team.roleOwner',
  ADMIN: 'team.roleAdmin',
  MEMBER: 'team.roleMember',
  VIEWER: 'team.roleViewer',
};

/** Função do utilizador e, se tiver, o perfil de acesso (ex.: "Membro · Operador"). */
export function useProfileLabel(): string {
  const { t } = useTranslation();
  const { user } = useAuth();
  if (!user) return '';
  const roleKey = ROLE_KEYS[user.role];
  const role = roleKey ? t(roleKey) : user.role;
  return user.accessProfile ? `${role} · ${user.accessProfile.name}` : role;
}
