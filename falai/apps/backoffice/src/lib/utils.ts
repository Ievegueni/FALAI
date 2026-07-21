import { formatInTimeZone } from 'date-fns-tz';
import { ptBR } from 'date-fns/locale';
import type { AgentStatus, CallStatus, TenantStatus, TransactionType } from '@/types';

const TZ = 'Africa/Luanda';

export function formatAOA(cents: number): string {
  return (
    new Intl.NumberFormat('pt-AO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
      cents / 100,
    ) + ' Kz'
  );
}

export function formatDate(iso: string): string {
  return formatInTimeZone(new Date(iso), TZ, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
}

export function formatDateShort(iso: string): string {
  return formatInTimeZone(new Date(iso), TZ, 'dd/MM/yyyy', { locale: ptBR });
}

export function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function clsx(
  ...args: (string | undefined | null | false | Record<string, boolean>)[]
): string {
  const classes: string[] = [];
  for (const arg of args) {
    if (!arg) continue;
    if (typeof arg === 'string') classes.push(arg);
    else for (const [k, v] of Object.entries(arg)) if (v) classes.push(k);
  }
  return classes.join(' ');
}

export const tenantStatusLabel: Record<TenantStatus, string> = {
  TRIAL: 'Trial',
  ACTIVE: 'Activo',
  SUSPENDED: 'Suspenso',
  CLOSED: 'Encerrado',
};

export const tenantStatusColor: Record<TenantStatus, string> = {
  TRIAL: 'bg-blue-100 text-blue-700',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  SUSPENDED: 'bg-red-100 text-red-700',
  CLOSED: 'bg-gray-100 text-gray-500',
};

export const agentStatusLabel: Record<AgentStatus, string> = {
  DRAFT: 'Rascunho',
  PENDING_REVIEW: 'Em revisão',
  ACTIVE: 'Activo',
  PAUSED: 'Pausado',
  BLOCKED: 'Bloqueado',
};

export const agentStatusColor: Record<AgentStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  PENDING_REVIEW: 'bg-amber-100 text-amber-700',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  PAUSED: 'bg-blue-100 text-blue-700',
  BLOCKED: 'bg-red-100 text-red-700',
};

export const callStatusLabel: Record<CallStatus, string> = {
  QUEUED: 'Na fila',
  DIALING: 'A ligar',
  RINGING: 'A chamar',
  IN_PROGRESS: 'Em curso',
  COMPLETED: 'Concluída',
  NO_ANSWER: 'Sem resposta',
  FAILED: 'Falhou',
  CANCELLED: 'Cancelada',
  ESCALATED: 'Escalada',
};

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

export const txTypeLabel: Record<TransactionType, string> = {
  TOPUP: 'Carregamento',
  CALL_CHARGE: 'Chamada',
  SMS_CHARGE: 'SMS',
  REFUND: 'Reembolso',
  ADJUSTMENT: 'Ajuste',
  MONTHLY_FEE: 'Fee mensal',
};
