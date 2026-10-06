import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BookOpen, Plus, Search } from 'lucide-react';
import { kbApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageSpinner } from '@/components/ui/Spinner';
import { useAuth } from '@/contexts/AuthContext';
import { isOpsManager } from '@/lib/roles';
import { formatDate } from '@/lib/utils';
import { KbArticleModal, KbEditorModal } from '@/components/knowledge/KbBits';

export function KnowledgePage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canWrite = isOpsManager(user?.role) || user?.role === 'SUPERVISOR';
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['kb', 'list', q, category], queryFn: () => kbApi.list({ ...(q.trim() && { q }), ...(category && { category }) }) });

  return (
    <>
      <Header title={t('kb.title')} actions={canWrite && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>{t('kb.new')}</Button>} />
      <div className="max-w-4xl space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap gap-2">
          <div className="min-w-0 flex-1 basis-60"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('kb.searchPlaceholder')} icon={<Search className="h-4 w-4" />} /></div>
          {(data?.categories.length ?? 0) > 0 && (
            <select className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t('kb.allCategories')}</option>
              {data!.categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
        {isLoading || !data ? <PageSpinner /> : data.data.length === 0 ? (
          <EmptyState icon={<BookOpen className="h-8 w-8" />} title={q ? t('kb.noResults') : t('kb.emptyTitle')} description={t('kb.emptyDescription')} />
        ) : (
          <Card padding={false}>
            <ul className="divide-y divide-gray-100">
              {data.data.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => setOpen(a.id)} className="w-full px-5 py-3 text-left hover:bg-gray-50">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-gray-900">{a.title}</p>
                      {a.category && <Badge className="bg-gray-100 text-gray-600">{a.category}</Badge>}
                      {!a.isPublished && <Badge className="bg-amber-100 text-amber-700">{t('kb.draft')}</Badge>}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-gray-500">{a.excerpt}</p>
                    <p className="mt-0.5 text-[11px] text-gray-400">{formatDate(a.updatedAt)}</p>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      <KbArticleModal id={open} onClose={() => setOpen(null)} />
      {creating && <KbEditorModal article="new" onClose={() => setCreating(false)} />}
    </>
  );
}
