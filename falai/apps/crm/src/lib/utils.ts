import { formatInTimeZone } from 'date-fns-tz';
import i18n from '@/i18n';
import type { AgentStatus, CallStatus, CampaignStatus, TransactionType } from '@/types';

const TZ = 'Africa/Luanda';

export function formatAOA(cents: number): string {
  const amount = cents / 100;
  return (
    new Intl.NumberFormat('pt-AO', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount) + ' Kz'
  );
}

export function formatDate(iso: string): string {
  return formatInTimeZone(new Date(iso), TZ, 'dd/MM/yyyy HH:mm');
}

export function formatDateShort(iso: string): string {
  return formatInTimeZone(new Date(iso), TZ, 'dd/MM/yyyy');
}

export function formatTime(iso: string): string {
  return formatInTimeZone(new Date(iso), TZ, 'HH:mm');
}

export function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function formatPhone(phone: string): string {
  // Mostra sempre no formato nacional 9XX XXX XXX (sem +244).
  // Aceita dados legados em +244XXXXXXXXX e o novo formato nacional de 9 dígitos.
  const digits = phone.replace(/\D/g, '');
  const local = digits.startsWith('244') && digits.length === 12 ? digits.slice(3) : digits;
  if (local.length === 9) {
    return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
  }
  return phone;
}

export function clsx(...args: (string | undefined | null | false | Record<string, boolean>)[]): string {
  const classes: string[] = [];
  for (const arg of args) {
    if (!arg) continue;
    if (typeof arg === 'string') {
      classes.push(arg);
    } else {
      for (const [k, v] of Object.entries(arg)) {
        if (v) classes.push(k);
      }
    }
  }
  return classes.join(' ');
}

// ─── Status labels & colours ─────────────────────────────────────────────────
// As etiquetas são traduzidas em runtime via i18n; as cores são estáticas.
// Os componentes que as usam subscrevem useTranslation(), pelo que re-renderizam
// ao mudar de idioma.

export const agentStatusLabel = (s: AgentStatus): string => i18n.t(`status.agent.${s}`);

export const agentStatusColor: Record<AgentStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  PENDING_REVIEW: 'bg-amber-100 text-amber-700',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  PAUSED: 'bg-blue-100 text-blue-700',
  BLOCKED: 'bg-red-100 text-red-700',
};

export const callStatusLabel = (s: CallStatus): string => i18n.t(`status.call.${s}`);

export const callStatusColor: Record<CallStatus, string> = {
  QUEUED: 'bg-gray-100 text-gray-700',
  DIALING: 'bg-blue-100 text-blue-700',
  RINGING: 'bg-blue-100 text-blue-700',
  IN_PROGRESS: 'bg-indigo-100 text-indigo-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  NO_ANSWER: 'bg-amber-100 text-amber-700',
  FAILED: 'bg-red-100 text-red-700',
  CANCELLED: 'bg-gray-100 text-gray-500',
  ESCALATED: 'bg-purple-100 text-purple-700',
};

export const campaignStatusLabel = (s: CampaignStatus): string => i18n.t(`status.campaign.${s}`);

export const campaignStatusColor: Record<CampaignStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  PAUSED: 'bg-amber-100 text-amber-700',
  COMPLETED: 'bg-blue-100 text-blue-700',
  CANCELLED: 'bg-red-100 text-red-700',
};

export const transactionTypeLabel = (t: TransactionType): string => i18n.t(`tx.${t}`);

export const daysOfWeekLabel = (): string[] =>
  i18n.t('days', { returnObjects: true }) as string[];
