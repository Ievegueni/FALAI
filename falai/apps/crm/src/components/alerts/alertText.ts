import type { TFunction } from 'i18next';
import type { OpsAlert } from '@/lib/api';
import { formatDuration } from '@/lib/utils';

const SECS = new Set(['LONG_WAIT', 'LONG_HANDLE', 'TMA_ABOVE']);
const PCT = new Set(['SLA_BELOW', 'ABANDON_ABOVE']);

/** Valor de um alerta no formato do seu tipo (duração, % ou nº de agentes). */
export function alertValue(type: OpsAlert['type'], v: number | null): string {
  if (v === null) return '—';
  if (SECS.has(type)) return formatDuration(v);
  if (PCT.has(type)) return `${v}%`;
  return String(v);
}

/** Frase do alerta, ex.: "Chamada em espera há 2m 10s (limite 1m 0s) · VENDAS". */
export function alertText(t: TFunction, a: Pick<OpsAlert, 'type' | 'value' | 'threshold'> & { group?: string | null }): string {
  const text = t(`alerts.type.${a.type}`, { value: alertValue(a.type, a.value), threshold: alertValue(a.type, a.threshold) });
  return a.group ? `${text} · ${a.group}` : text;
}
