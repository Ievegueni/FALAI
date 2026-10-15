import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import type { QaStatus } from '@/lib/api';

const STATUS_CLASS: Record<QaStatus, string> = {
  SUBMITTED: 'bg-blue-100 text-blue-700',
  ACKNOWLEDGED: 'bg-emerald-100 text-emerald-700',
  DISPUTED: 'bg-amber-100 text-amber-700',
  RESOLVED: 'bg-gray-100 text-gray-600',
};

export function QaStatusBadge({ status }: { status: QaStatus }) {
  const { t } = useTranslation();
  return <Badge className={STATUS_CLASS[status]}>{t(`quality.status.${status}`)}</Badge>;
}

/** Cor do score: verde ≥ 85, âmbar ≥ 70, vermelho abaixo. */
export const scoreClass = (s: number | null) => (s === null ? 'text-gray-400' : s >= 85 ? 'text-emerald-600' : s >= 70 ? 'text-amber-600' : 'text-red-600');
