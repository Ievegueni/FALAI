import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { qaApi, type QaDefinition, type QaForm, type QaStatus } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pagination } from '@/components/ui/Pagination';
import { PageSpinner } from '@/components/ui/Spinner';
import { Tabs } from '@/components/ui/Tabs';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { isOpsManager } from '@/lib/roles';
import { clsx, formatDate, formatDuration, formatPhone } from '@/lib/utils';
import { QaStatusBadge, scoreClass } from './QualityBits';

const STATUSES: QaStatus[] = ['SUBMITTED', 'ACKNOWLEDGED', 'DISPUTED', 'RESOLVED'];
const th = 'px-4 py-2.5 font-medium';
const td = 'px-4 py-2.5';

function Evaluations() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [f, setF] = useState({ status: '' as QaStatus | '', page: 1 });
  const { data, isLoading } = useQuery({ queryKey: ['qa', 'list', f], queryFn: () => qaApi.list({ page: f.page, ...(f.status && { status: f.status }) }) });
  return (
    <div className="space-y-4">
      <select className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" value={f.status} onChange={(e) => setF({ status: e.target.value as QaStatus | '', page: 1 })}>
        <option value="">{t('quality.allStatuses')}</option>
        {STATUSES.map((s) => <option key={s} value={s}>{t(`quality.status.${s}`)}</option>)}
      </select>
      {isLoading || !data ? <PageSpinner /> : data.total === 0 ? (
        <Card><p className="py-6 text-center text-sm text-gray-400">{t('quality.empty')}</p></Card>
      ) : (
        <Card padding={false} className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>{['date', 'agent', 'form', 'evaluator', 'score', 'statusLabel'].map((k) => <th key={k} className={th}>{t(`quality.col.${k}`)}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.data.map((e) => (
                <tr key={e.id} className="cursor-pointer hover:bg-gray-50" onClick={() => navigate(`/quality/evaluations/${e.id}`)}>
                  <td className={`${td} text-gray-600`}>{formatDate(e.createdAt)}</td>
                  <td className={`${td} font-medium text-gray-900`}>{e.agent.name}</td>
                  <td className={`${td} text-gray-600`}>{e.form?.name ?? '—'}</td>
                  <td className={`${td} text-gray-600`}>{e.evaluator.name}</td>
                  <td className={clsx(td, 'font-semibold', scoreClass(e.score))}>{e.score}{e.criticalFail && ' ⚠'}</td>
                  <td className={td}><QaStatusBadge status={e.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-4 py-3"><Pagination page={data.page} total={data.total} perPage={data.perPage} onPage={(page) => setF((x) => ({ ...x, page }))} /></div>
        </Card>
      )}
    </div>
  );
}

function Summary() {
  const { t } = useTranslation();
  const monthAgo = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const { data, isLoading } = useQuery({ queryKey: ['qa', 'summary', from, to], queryFn: () => qaApi.summary({ from, to }) });
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-4">
        <div><label className="mb-1 block text-xs font-medium text-gray-500">{t('reports.from')}</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" /></div>
        <div><label className="mb-1 block text-xs font-medium text-gray-500">{t('reports.to')}</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" /></div>
      </Card>
      {isLoading || !data ? <PageSpinner /> : (
        <Card padding={false} className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>{['agent', 'evaluations', 'avgScore', 'criticalFails', 'disputed'].map((k) => <th key={k} className={th}>{t(`quality.col.${k}`)}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.map((r) => (
                <tr key={r.agentId}>
                  <td className={`${td} font-medium text-gray-900`}>{r.agent}</td>
                  <td className={td}>{r.evaluations}</td>
                  <td className={clsx(td, 'font-semibold', scoreClass(r.avgScore))}>{r.avgScore ?? '—'}</td>
                  <td className={td}>{r.criticalFails}</td>
                  <td className={td}>{r.disputed}</td>
                </tr>
              ))}
              {data.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">{t('quality.empty')}</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function Sample() {
  const { t } = useTranslation();
  const [days, setDays] = useState(7);
  const { data, isLoading, refetch, isFetching } = useQuery({ queryKey: ['qa', 'sample', days], queryFn: () => qaApi.sample({ days, perAgent: 2 }) });
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-3">
        <select className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 14, 30].map((d) => <option key={d} value={d}>{t('quality.lastDays', { count: d })}</option>)}
        </select>
        <Button size="sm" variant="outline" loading={isFetching} onClick={() => void refetch()}>{t('quality.reshuffle')}</Button>
        <p className="text-xs text-gray-500">{t('quality.sampleHint')}</p>
      </Card>
      {isLoading || !data ? <PageSpinner /> : data.map((a) => (
        <Card key={a.agentId}>
          <p className="mb-2 text-sm font-semibold text-gray-900">{a.agent}</p>
          {a.calls.length === 0 ? <p className="text-sm text-gray-400">{t('quality.nothingToEvaluate')}</p> : (
            <ul className="divide-y divide-gray-100">
              {a.calls.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <Link to={`/calls/${c.id}`} className="text-gray-700 hover:text-blue-600">{formatPhone(c.fromNumber)} · {formatDate(c.at)} · {formatDuration(c.durationSecs)}</Link>
                  <Link to={`/quality/new?callId=${c.id}`}><Button size="sm">{t('quality.evaluate')}</Button></Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}

const blankForm = (): QaDefinition => ({ sections: [{ title: '', criteria: [{ label: '', weight: 1, critical: false }] }] });

function FormEditor({ form, onClose }: { form: QaForm | 'new'; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const [name, setName] = useState(form === 'new' ? '' : form.name);
  const [def, setDef] = useState<QaDefinition>(form === 'new' ? blankForm() : structuredClone(form.definition));
  const upd = (fn: (d: QaDefinition) => void) => setDef((d) => { const c = structuredClone(d); fn(c); return c; });
  const save = useMutation({
    mutationFn: () => (form === 'new' ? qaApi.createForm({ name, definition: def }) : qaApi.updateForm(form.id, { name, definition: def })),
    onSuccess: () => { success(t('common.saved')); void qc.invalidateQueries({ queryKey: ['qa', 'forms'] }); onClose(); },
    onError: (e: Error) => error(e.message),
  });
  return (
    <Modal open onClose={onClose} size="xl" title={form === 'new' ? t('quality.newForm') : t('quality.editForm')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>{t('common.save')}</Button></>}>
      <div className="space-y-4">
        <Input label={t('quality.formName')} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        {form !== 'new' && <p className="text-xs text-gray-500">{t('quality.editHint')}</p>}
        {def.sections.map((s, si) => (
          <div key={si} className="space-y-2 rounded-lg border border-gray-200 p-3">
            <div className="flex gap-2">
              <div className="flex-1"><Input placeholder={t('quality.sectionTitle')} value={s.title} onChange={(e) => upd((d) => { d.sections[si]!.title = e.target.value; })} /></div>
              {def.sections.length > 1 && <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />} onClick={() => upd((d) => { d.sections.splice(si, 1); })} />}
            </div>
            {s.criteria.map((c, ci) => (
              <div key={ci} className="flex flex-wrap items-center gap-2 pl-3">
                <div className="min-w-[12rem] flex-1"><Input placeholder={t('quality.criterion')} value={c.label} onChange={(e) => upd((d) => { d.sections[si]!.criteria[ci]!.label = e.target.value; })} /></div>
                <label className="flex items-center gap-1 text-xs text-gray-600">{t('quality.weight')}
                  <input type="number" min={1} max={100} value={c.weight} onChange={(e) => upd((d) => { d.sections[si]!.criteria[ci]!.weight = Math.max(1, Number(e.target.value) || 1); })} className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
                </label>
                <label className="flex items-center gap-1 text-xs text-gray-600">
                  <input type="checkbox" checked={c.critical} onChange={(e) => upd((d) => { d.sections[si]!.criteria[ci]!.critical = e.target.checked; })} />{t('quality.critical')}
                </label>
                {s.criteria.length > 1 && <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />} onClick={() => upd((d) => { d.sections[si]!.criteria.splice(ci, 1); })} />}
              </div>
            ))}
            <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => upd((d) => { d.sections[si]!.criteria.push({ label: '', weight: 1, critical: false }); })}>{t('quality.addCriterion')}</Button>
          </div>
        ))}
        <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => upd((d) => { d.sections.push({ title: '', criteria: [{ label: '', weight: 1, critical: false }] }); })}>{t('quality.addSection')}</Button>
      </div>
    </Modal>
  );
}

function Forms() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { error } = useToast();
  const [editing, setEditing] = useState<QaForm | 'new' | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['qa', 'forms', 'all'], queryFn: () => qaApi.forms(true) });
  const toggle = useMutation({
    mutationFn: (f: QaForm) => qaApi.updateForm(f.id, { name: f.name, definition: f.definition, isActive: !f.isActive }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['qa', 'forms'] }),
    onError: (e: Error) => error(e.message),
  });
  if (isLoading) return <PageSpinner />;
  return (
    <div className="space-y-4">
      <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>{t('quality.newForm')}</Button>
      <Card padding={false}>
        <div className="divide-y divide-gray-50">
          {data?.map((f) => (
            <div key={f.id} className="flex items-center gap-4 px-5 py-3">
              <div className="flex-1">
                <p className={clsx('text-sm font-medium', f.isActive ? 'text-gray-900' : 'text-gray-400 line-through')}>{f.name}</p>
                <p className="text-xs text-gray-400">{t('quality.criteriaCount', { count: f.definition.sections.reduce((n, s) => n + s.criteria.length, 0) })}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setEditing(f)}>{t('common.edit')}</Button>
              <Button size="sm" variant="ghost" onClick={() => toggle.mutate(f)}>{f.isActive ? t('telephony.deactivate') : t('telephony.activate')}</Button>
            </div>
          ))}
          {data?.length === 0 && <p className="px-5 py-8 text-center text-sm text-gray-400">{t('quality.noForms')}</p>}
        </div>
      </Card>
      {editing && <FormEditor form={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

export function QualityPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const ops = isOpsManager(user?.role);
  const evaluator = ops || user?.role === 'SUPERVISOR';
  const [tab, setTab] = useState('evaluations');
  return (
    <>
      <Header title={t('quality.title')} />
      <div className="space-y-6 p-4 sm:p-6">
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'evaluations', label: t('quality.tabEvaluations') },
            { key: 'summary', label: t('quality.tabSummary') },
            ...(evaluator ? [{ key: 'sample', label: t('quality.tabSample') }] : []),
            ...(ops ? [{ key: 'forms', label: t('quality.tabForms') }] : []),
          ]}
        />
        {tab === 'evaluations' && <Evaluations />}
        {tab === 'summary' && <Summary />}
        {tab === 'sample' && evaluator && <Sample />}
        {tab === 'forms' && ops && <Forms />}
      </div>
    </>
  );
}
