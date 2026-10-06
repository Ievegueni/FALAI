import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, Flag } from 'lucide-react';
import { qaApi, type QaAnswer, type QaDefinition } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Input';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import { clsx, formatDate } from '@/lib/utils';
import { QaStatusBadge, scoreClass } from './QualityBits';

const ANSWERS: QaAnswer[] = ['YES', 'NO', 'NA'];

/** Grelha de critérios: Conforme / Não conforme / Não aplicável. */
function CriteriaGrid({ def, answers, onChange }: { def: QaDefinition; answers: Record<string, QaAnswer>; onChange?: (id: string, a: QaAnswer) => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      {def.sections.map((s, si) => (
        <Card key={si}>
          <h2 className="mb-3 text-sm font-semibold text-gray-900">{s.title}</h2>
          <div className="divide-y divide-gray-100">
            {s.criteria.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <p className="text-sm text-gray-800">
                  {c.label}
                  <span className="ml-2 text-xs text-gray-400">×{c.weight}</span>
                  {c.critical && <span className="ml-2 rounded bg-red-50 px-1.5 text-xs text-red-600">{t('quality.critical')}</span>}
                </p>
                <div className="inline-flex rounded-lg border border-gray-300 p-0.5">
                  {ANSWERS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      disabled={!onChange}
                      onClick={() => onChange?.(c.id!, a)}
                      className={clsx(
                        'rounded-md px-2.5 py-1 text-xs',
                        answers[c.id!] === a
                          ? a === 'YES' ? 'bg-emerald-600 text-white' : a === 'NO' ? 'bg-red-600 text-white' : 'bg-gray-600 text-white'
                          : 'text-gray-600 hover:bg-gray-100 disabled:hover:bg-transparent',
                      )}
                    >
                      {t(`quality.answer.${a}`)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Nova avaliação: /quality/new?callId=… (ou conversationId / ticketId). */
export function NewEvaluationPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { error } = useToast();
  const [params] = useSearchParams();
  const ref = { callId: params.get('callId') ?? undefined, conversationId: params.get('conversationId') ?? undefined, ticketId: params.get('ticketId') ?? undefined };
  const { data: forms, isLoading } = useQuery({ queryKey: ['qa', 'forms'], queryFn: () => qaApi.forms() });
  const [formId, setFormId] = useState('');
  const [answers, setAnswers] = useState<Record<string, QaAnswer>>({});
  const [comment, setComment] = useState('');
  useEffect(() => { if (!formId && forms?.[0]) setFormId(forms[0].id); }, [forms, formId]);
  const form = forms?.find((f) => f.id === formId);

  const create = useMutation({
    mutationFn: () => qaApi.create({ formId, ...ref, answers, ...(comment.trim() && { comment: comment.trim() }) }),
    onSuccess: (ev) => navigate(`/quality/evaluations/${ev.id}`, { replace: true }),
    onError: (e: Error) => error(e.message),
  });

  if (isLoading) return <><Header title={t('quality.newTitle')} /><PageSpinner /></>;
  return (
    <>
      <Header title={t('quality.newTitle')} actions={<Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => navigate(-1)}>{t('common.back')}</Button>} />
      <div className="max-w-3xl space-y-4 p-4 sm:p-6">
        {!forms?.length ? (
          <Card><p className="text-sm text-gray-500">{t('quality.noForms')}</p></Card>
        ) : (
          <>
            <Card className="flex flex-wrap items-center gap-3">
              <select className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" value={formId} onChange={(e) => { setFormId(e.target.value); setAnswers({}); }}>
                {forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              {ref.callId && <Link to={`/calls/${ref.callId}`} className="text-sm text-blue-600 hover:underline">{t('quality.openCall')}</Link>}
            </Card>
            {form && <CriteriaGrid def={form.definition} answers={answers} onChange={(id, a) => setAnswers((x) => ({ ...x, [id]: a }))} />}
            <Card>
              <Textarea label={t('quality.comment')} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('quality.commentPlaceholder')} />
              <div className="mt-3 flex justify-end">
                <Button loading={create.isPending} onClick={() => create.mutate()}>{t('quality.submit')}</Button>
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  );
}

/** Ver avaliação: o agente confirma ou contesta; o avaliador/gestor revê. */
export function EvaluationPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { success, error } = useToast();
  const { data: ev, isLoading } = useQuery({ queryKey: ['qa', 'evaluation', id], queryFn: () => qaApi.get(id!) });
  const [note, setNote] = useState('');
  const [answers, setAnswers] = useState<Record<string, QaAnswer> | null>(null);
  const [resolution, setResolution] = useState('');
  const done = () => { success(t('common.saved')); setNote(''); setAnswers(null); setResolution(''); void qc.invalidateQueries({ queryKey: ['qa'] }); };

  const ack = useMutation({ mutationFn: () => qaApi.acknowledge(id!, note.trim() || undefined), onSuccess: done, onError: (e: Error) => error(e.message) });
  const dispute = useMutation({ mutationFn: () => qaApi.dispute(id!, note.trim()), onSuccess: done, onError: (e: Error) => error(e.message) });
  const revise = useMutation({
    mutationFn: () => qaApi.revise(id!, { ...(answers && { answers }), ...(resolution.trim() && { resolution: resolution.trim() }) }),
    onSuccess: done,
    onError: (e: Error) => error(e.message),
  });

  if (isLoading) return <><Header title={t('quality.evaluation')} /><PageSpinner /></>;
  if (!ev) return <><Header title={t('quality.evaluation')} /><div className="p-6 text-sm text-gray-500">{t('quality.notFound')}</div></>;
  const editing = answers !== null;

  return (
    <>
      <Header title={t('quality.evaluation')} actions={<Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => navigate('/quality')}>{t('common.back')}</Button>} />
      <div className="max-w-3xl space-y-4 p-4 sm:p-6">
        <Card className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-lg font-semibold text-gray-900">{ev.agent.name}</p>
            <p className="text-xs text-gray-500">
              {ev.formSnapshot.name} · {t('quality.by', { name: ev.evaluator.name })} · {formatDate(ev.createdAt)}
              {ev.callId && <> · <Link to={`/calls/${ev.callId}`} className="text-blue-600 hover:underline">{t('quality.openCall')}</Link></>}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <QaStatusBadge status={ev.status} />
            <span className={clsx('text-2xl font-bold', scoreClass(ev.score))}>{ev.score}</span>
          </div>
        </Card>
        {ev.criticalFail && <Card className="border-red-200 bg-red-50 text-sm text-red-700">{t('quality.criticalFail')}</Card>}

        <CriteriaGrid def={ev.formSnapshot} answers={answers ?? ev.answers} {...(editing && { onChange: (cid: string, a: QaAnswer) => setAnswers((x) => ({ ...x!, [cid]: a })) })} />

        {ev.comment && <Card><p className="mb-1 text-xs font-medium text-gray-500">{t('quality.comment')}</p><p className="whitespace-pre-wrap text-sm text-gray-800">{ev.comment}</p></Card>}
        {ev.agentComment && <Card><p className="mb-1 text-xs font-medium text-gray-500">{t('quality.agentComment')}</p><p className="whitespace-pre-wrap text-sm text-gray-800">{ev.agentComment}</p></Card>}
        {ev.resolution && <Card><p className="mb-1 text-xs font-medium text-gray-500">{t('quality.resolution')}</p><p className="whitespace-pre-wrap text-sm text-gray-800">{ev.resolution}</p></Card>}

        {/* Agente: confirmar leitura ou contestar */}
        {ev.isMine && ev.status === 'SUBMITTED' && (
          <Card className="space-y-3">
            <Textarea label={t('quality.agentNote')} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" icon={<Flag className="h-4 w-4" />} disabled={!note.trim()} loading={dispute.isPending} onClick={() => dispute.mutate()}>{t('quality.dispute')}</Button>
              <Button icon={<Check className="h-4 w-4" />} loading={ack.isPending} onClick={() => ack.mutate()}>{t('quality.acknowledge')}</Button>
            </div>
          </Card>
        )}

        {/* Avaliador / gestor: rever respostas e responder à contestação */}
        {ev.canEdit && (
          <Card className="space-y-3">
            {ev.status === 'DISPUTED' && (
              <Textarea label={t('quality.resolution')} rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} />
            )}
            <div className="flex justify-end gap-2">
              {!editing ? (
                <Button variant="outline" onClick={() => setAnswers(ev.answers)}>{t('quality.reviseAnswers')}</Button>
              ) : (
                <Button variant="ghost" onClick={() => setAnswers(null)}>{t('common.cancel')}</Button>
              )}
              {(editing || resolution.trim()) && <Button loading={revise.isPending} onClick={() => revise.mutate()}>{t('common.save')}</Button>}
            </div>
            <p className="text-xs text-gray-400">{t('quality.auditHint')}</p>
          </Card>
        )}
      </div>
    </>
  );
}
