import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardList } from 'lucide-react';
import { callTypingApi, type TypingStatus } from '@/lib/api';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Select, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { formatPhone } from '@/lib/utils';

/**
 * Tipificação pós-chamada no webphone (melhoria 2). Com tipificação
 * obrigatória, a extensão não recebe chamadas até tipificar ou até o prazo
 * acabar — quem garante isso é o servidor; aqui só se mostra o tempo que falta.
 */

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function secsLeft(until: string | null, now: number): number | null {
  if (!until) return null;
  return Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000));
}

export function TypingModal({ legId, onClose }: { legId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [note, setNote] = useState('');

  const { data } = useQuery({
    queryKey: ['leg-typing', legId],
    queryFn: () => callTypingApi.legTyping(legId!),
    enabled: legId !== null,
  });
  // Edição: começa com o que já estava gravado.
  useEffect(() => {
    setCategoryId(data?.categoryId ?? '');
    setSubcategoryId(data?.subcategoryId ?? '');
    setNote(data?.note ?? '');
  }, [data]);

  const pending = data?.status === 'PENDING';
  const left = secsLeft(data?.wrapUpEndsAt ?? null, useNow(pending));
  const tops = data?.categories.filter((c) => c.parentId === null) ?? [];
  const subs = data?.categories.filter((c) => c.parentId === categoryId) ?? [];
  const valid = categoryId !== '' && (subs.length === 0 || subcategoryId !== '');

  const save = useMutation({
    mutationFn: () =>
      callTypingApi.saveTyping(legId!, { categoryId, subcategoryId: subcategoryId || null, note: note.trim() || null }),
    onSuccess: () => {
      success(t('webphone.typingSaved'));
      void qc.invalidateQueries({ queryKey: ['untyped-legs'] });
      void qc.invalidateQueries({ queryKey: ['leg-typing', legId] });
      onClose();
    },
    onError: (e: Error) => error(e.message),
  });

  return (
    <Modal
      open={legId !== null}
      onClose={onClose}
      size="sm"
      title={t('webphone.typingTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {data?.from && <p className="text-sm text-gray-500">{formatPhone(data.from)}</p>}
        {pending && left !== null && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{t('webphone.typingDeadline', { secs: left })}</p>
        )}
        {tops.length === 0 ? (
          <p className="text-sm text-gray-500">{t('webphone.typingNoCategories')}</p>
        ) : (
          <>
            <Select label={t('webphone.typingCategory')} value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setSubcategoryId(''); }}>
              <option value="">—</option>
              {tops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            {subs.length > 0 && (
              <Select label={t('webphone.typingSubcategory')} value={subcategoryId} onChange={(e) => setSubcategoryId(e.target.value)}>
                <option value="">—</option>
                {subs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            )}
            <Textarea label={t('webphone.typingNote')} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} />
          </>
        )}
      </div>
    </Modal>
  );
}

const STATUS_CLASS: Partial<Record<TypingStatus, string>> = {
  PENDING: 'bg-amber-50 text-amber-700',
  NOT_TYPED: 'bg-gray-100 text-gray-600',
};

/** Chamadas atendidas por esta extensão ainda sem tipificação (inclui as do telefone físico). */
export function UntypedList({ extensionId, onPick }: { extensionId: string | null; onPick: (legId: string) => void }) {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['untyped-legs', extensionId],
    queryFn: () => callTypingApi.untyped(extensionId!),
    enabled: extensionId !== null,
    refetchInterval: 15_000,
  });
  const now = useNow(Boolean(data?.some((l) => l.status === 'PENDING')));
  if (!data || data.length === 0) return null;
  return (
    <Card padding={false}>
      <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100">
        <ClipboardList className="h-4 w-4 text-gray-400" />
        <h2 className="text-sm font-semibold text-gray-900">{t('webphone.untypedTitle', { count: data.length })}</h2>
      </div>
      <div className="divide-y divide-gray-50">
        {data.map((l) => {
          const left = l.status === 'PENDING' ? secsLeft(l.wrapUpEndsAt, now) : null;
          return (
            <div key={l.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
              <span className="flex-1 text-gray-700">
                {formatPhone(l.from)} <span className="text-gray-400">· {new Date(l.at).toLocaleString()}</span>
              </span>
              <Badge className={STATUS_CLASS[l.status] ?? ''}>
                {left !== null ? t('webphone.typingLeft', { secs: left }) : t('webphone.typingNotTyped')}
              </Badge>
              <Button size="sm" variant="outline" onClick={() => onPick(l.id)}>{t('webphone.typingAction')}</Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
