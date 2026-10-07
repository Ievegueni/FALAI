import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { shiftsApi, type ShiftInput } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';

// Segunda primeiro, como se lê um horário; weekday segue o JS (0 = domingo).
const DAYS = [1, 2, 3, 4, 5, 6, 0];
type Row = { on: boolean; start: string; end: string };

/**
 * Turno semanal de um utilizador: um horário por dia.
 * ponytail: um intervalo por dia na UI (a API aceita vários) — acrescentar
 * quando houver turnos partidos.
 */
export function ShiftsModal({ user, onClose }: { user: { id: string; name: string } | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['shifts', user?.id], queryFn: () => shiftsApi.get(user!.id), enabled: !!user });
  const [rows, setRows] = useState<Record<number, Row>>({});
  useEffect(() => {
    if (!data) return;
    setRows(Object.fromEntries(DAYS.map((d) => {
      const s = data.find((x) => x.weekday === d);
      return [d, { on: !!s, start: s?.start ?? '08:00', end: s?.end ?? '17:00' }];
    })));
  }, [data]);
  const set = (d: number, p: Partial<Row>) => setRows((r) => ({ ...r, [d]: { ...r[d]!, ...p } }));

  const save = useMutation({
    mutationFn: () => shiftsApi.save(user!.id, DAYS.filter((d) => rows[d]?.on).map((d): ShiftInput => ({ weekday: d, start: rows[d]!.start, end: rows[d]!.end }))),
    onSuccess: () => { success(t('common.saved')); void qc.invalidateQueries({ queryKey: ['shifts', user?.id] }); onClose(); },
    onError: (e: Error) => error(e.message),
  });

  return (
    <Modal
      open={!!user}
      onClose={onClose}
      title={t('team.shiftsTitle', { name: user?.name ?? '' })}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button></>}
    >
      {isLoading || Object.keys(rows).length === 0 ? <PageSpinner /> : (
        <div className="space-y-2">
          {DAYS.map((d) => (
            <div key={d} className="flex items-center gap-3">
              <label className="flex w-32 items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={rows[d]!.on} onChange={(e) => set(d, { on: e.target.checked })} />
                {t(`team.weekday.${d}`)}
              </label>
              <input type="time" value={rows[d]!.start} disabled={!rows[d]!.on} onChange={(e) => set(d, { start: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1 text-sm disabled:opacity-40" />
              <span className="text-gray-400">–</span>
              <input type="time" value={rows[d]!.end} disabled={!rows[d]!.on} onChange={(e) => set(d, { end: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1 text-sm disabled:opacity-40" />
            </div>
          ))}
          <p className="pt-1 text-xs text-gray-500">{t('team.shiftsHint')}</p>
        </div>
      )}
    </Modal>
  );
}
