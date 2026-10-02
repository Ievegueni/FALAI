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
  Headphones,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import type { FeatureKey, TenantUser } from '@/types';

type NavItem = { to: string; icon: typeof Bot; labelKey: string };
const item = (to: string, icon: typeof Bot, key: string): NavItem => ({ to, icon, labelKey: `nav.${key}` });
const SUPERVISION_ROLES = new Set(['OWNER', 'ADMIN', 'SUPERVISOR']);

/** Itens do menu que o utilizador pode ver (features do tenant + perfil de acesso), pela ordem do menu. */
export function useNavItems(): NavItem[] {
  const { user, tenant } = useAuth();

  const features = tenant?.features;
  const ownPbx = tenant?.plan?.productType === 'CRM_BYO_PBX';

  // Mostra um item se a sua feature estiver activa (default: visível se não houver info de features)
  const isOn = (f: FeatureKey) => features?.[f] !== false;

  // SMS: a feature já vem desligada da API quando o plano não inclui SMS
  const smsOn = tenant?.plan?.smsEnabled === true && isOn('sms');

  const all: [boolean, NavItem][] = [
    [canSeeDashboard(user), item('/dashboard', LayoutDashboard, 'dashboard')],
    [isOn('calls'), item('/calls', Phone, 'calls')],
    [isOn('webphone'), item('/webphone', PhoneCall, 'webphone')],
    [smsOn, item('/sms', MessageSquare, 'sms')],
    [features?.inbox === true, item('/inbox', Inbox, 'inbox')],
    [isOn('webphone') && !!user && SUPERVISION_ROLES.has(user.role), item('/supervision', Headphones, 'supervision')],
    [isOn('contacts'), item('/contacts', Users, 'contacts')],
    [isOn('campaigns'), item('/campaigns', Megaphone, 'campaigns')],
    [isOn('agents'), item('/agents', Bot, 'agents')],
    [isOn('team'), item('/team', UserCheck, 'team')],
    [isOn('reports'), item('/reports', BarChart3, 'reports')],
    [isOn('wallet'), item('/wallet', Wallet, 'wallet')],
    [isOn('developers'), item('/developers', Code2, 'developers')],
    [isOn('telephony'), item('/telephony', Network, 'telephony')],
    [true, item('/settings', Settings, 'settings')],
    [ownPbx, item('/settings/pbx', Server, 'pbx')],
  ];
  return all.filter(([show]) => show).map(([, i]) => i);
}

/** O perfil de acesso pode tirar o Dashboard (tem saldo e totais da conta). */
export function canSeeDashboard(user: TenantUser | null | undefined): boolean {
  return user?.accessProfile?.permissions?.dashboard !== 'none';
}

const ROLE_KEYS: Record<string, string> = {
  OWNER: 'team.roleOwner',
  ADMIN: 'team.roleAdmin',
  SUPERVISOR: 'team.roleSupervisor',
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
