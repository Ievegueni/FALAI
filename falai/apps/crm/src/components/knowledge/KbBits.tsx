import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BookOpen, Search } from 'lucide-react';
import { kbApi, type KbInput } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageSpinner } from '@/components/ui/Spinner';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { isOpsManager } from '@/lib/roles';

/** Ler um artigo (e, para quem escreve, editar ou apagar). */
export function KbArticleModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { error } = useToast();
  const [editing, setEditing] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['kb', 'article', id], queryFn: () => kbApi.get(id!), enabled: !!id });
  const remove = useMutation({
    mutationFn: () => kbApi.remove(id!),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['kb'] }); onClose(); },
    onError: (e: Error) => error(e.message),
  });
  if (!id) return null;
  if (editing && data) return <KbEditorModal article={data} onClose={() => { setEditing(false); onClose(); }} />;
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={data?.title ?? t('kb.title')}
      footer={data?.canEdit ? (
        <>
          {isOpsManager(user?.role) && (
            <Button variant="ghost" loading={remove.isPending} onClick={() => { if (confirm(t('kb.deleteConfirm'))) remove.mutate(); }}>{t('common.delete')}</Button>
          )}
          <Button onClick={() => setEditing(true)}>{t('common.edit')}</Button>
        </>
      ) : undefined}
    >
      {isLoading || !data ? <PageSpinner /> : (
        <div className="space-y-2">
          {data.category && <p className="text-xs text-gray-500">{data.category}</p>}
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800">{data.body}</p>
        </div>
      )}
    </Modal>
  );
}

/** Criar ou editar um artigo. */
export function KbEditorModal({ article, onClose }: { article: (KbInput & { id: string }) | 'new'; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [f, setF] = useState<KbInput>(article === 'new'
    ? { title: '', body: '', category: null, isPublished: true, aiEnabled: true }
    : { title: article.title, body: article.body, category: article.category, isPublished: article.isPublished, aiEnabled: article.aiEnabled });
  const save = useMutation({
    mutationFn: () => (article === 'new' ? kbApi.create(f) : kbApi.update(article.id, f)),
    onSuccess: () => { success(t('common.saved')); void qc.invalidateQueries({ queryKey: ['kb'] }); onClose(); },
    onError: (e: Error) => error(e.message),
  });
  return (
    <Modal open onClose={onClose} size="lg" title={article === 'new' ? t('kb.new') : t('kb.edit')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} disabled={f.title.trim().length < 2 || !f.body.trim()} onClick={() => save.mutate()}>{t('common.save')}</Button></>}>
      <div className="space-y-4">
        <Input label={t('kb.articleTitle')} value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <Input label={t('kb.category')} value={f.category ?? ''} maxLength={80} onChange={(e) => setF({ ...f, category: e.target.value || null })} />
        <Textarea label={t('kb.body')} rows={12} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        <div className="flex flex-wrap gap-4 text-sm text-gray-800">
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.isPublished} onChange={(e) => setF({ ...f, isPublished: e.target.checked })} />{t('kb.published')}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.aiEnabled} onChange={(e) => setF({ ...f, aiEnabled: e.target.checked })} />{t('kb.aiEnabled')}</label>
        </div>
      </div>
    </Modal>
  );
}

/** Pesquisa rápida (screen pop, ticket): escreve, vê os 5 mais relevantes, abre. */
export function KbQuickSearch({ initial = '' }: { initial?: string }) {
  const { t } = useTranslation();
  const { tenant } = useAuth();
  const [q, setQ] = useState(initial);
  const [open, setOpen] = useState<string | null>(null);
  const enabled = tenant?.features?.knowledge === true;
  const { data } = useQuery({ queryKey: ['kb', 'quick', q], queryFn: () => kbApi.list({ q, limit: 5 }), enabled: enabled && q.trim().length >= 3 });
  if (!enabled) return null;
  return (
    <div>
      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500"><BookOpen className="h-3.5 w-3.5" /> {t('kb.title')}</p>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('kb.searchPlaceholder')} icon={<Search className="h-4 w-4" />} />
      {q.trim().length >= 3 && (
        <ul className="mt-1 divide-y divide-gray-50">
          {data?.data.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => setOpen(a.id)} className="w-full py-1.5 text-left">
                <p className="text-sm text-gray-800 hover:text-blue-600">{a.title}</p>
                <p className="truncate text-xs text-gray-400">{a.excerpt}</p>
              </button>
            </li>
          ))}
          {data?.data.length === 0 && <li className="py-1.5 text-xs text-gray-400">{t('kb.noResults')}</li>}
        </ul>
      )}
      <KbArticleModal id={open} onClose={() => setOpen(null)} />
    </div>
  );
}
