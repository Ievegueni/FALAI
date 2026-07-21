import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { useTranslation, Trans } from 'react-i18next';
import { ArrowLeft, Upload, FileText, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { contactsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/contexts/ToastContext';
import type { ImportResult } from '@/types';

export function ImportPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { error } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const importMutation = useMutation({
    mutationFn: (file: File) => contactsApi.import(file),
    onSuccess: (res) => {
      if (res.jobId) {
        setJobId(res.jobId);
        pollProgress(res.jobId);
      } else {
        setResult(res);
      }
    },
    onError: (e: Error) => error(e.message),
  });

  function pollProgress(jid: string) {
    const interval = setInterval(async () => {
      try {
        const status = await contactsApi.importStatus(jid);
        setProgress(status.progress);
        if (status.done) {
          clearInterval(interval);
          setJobId(null);
          if (status.result) setResult(status.result);
        }
      } catch {
        clearInterval(interval);
      }
    }, 1500);
  }

  function handleFile(file: File) {
    const allowed = ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
    if (!allowed.includes(file.type) && !file.name.match(/\.(csv|xlsx)$/i)) {
      error(t('import.errFileType'));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      error(t('import.errTooLarge'));
      return;
    }
    setResult(null);
    importMutation.mutate(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  const isProcessing = importMutation.isPending || jobId !== null;

  return (
    <>
      <Header
        title={t('import.title')}
        actions={
          <Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => navigate('/contacts')}>
            {t('common.back')}
          </Button>
        }
      />

      <div className="p-6 max-w-2xl space-y-6">
        {/* Instructions */}
        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-3">{t('import.formatTitle')}</h2>
          <ul className="space-y-1 text-sm text-gray-600">
            <li className="flex gap-2"><span className="text-gray-400">1.</span> <span><Trans i18nKey="import.step1" components={[<code className="bg-gray-100 px-1 rounded text-xs" key="0" />, <code className="bg-gray-100 px-1 rounded text-xs" key="1" />, <code className="bg-gray-100 px-1 rounded text-xs" key="2" />]} /></span></li>
            <li className="flex gap-2"><span className="text-gray-400">2.</span> <span><Trans i18nKey="import.step2" components={[<code className="bg-gray-100 px-1 rounded text-xs" key="0" />, <code className="bg-gray-100 px-1 rounded text-xs" key="1" />, <code className="bg-gray-100 px-1 rounded text-xs" key="2" />]} /></span></li>
            <li className="flex gap-2"><span className="text-gray-400">3.</span> {t('import.step3')}</li>
            <li className="flex gap-2"><span className="text-gray-400">4.</span> {t('import.step4')}</li>
          </ul>
        </Card>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => !isProcessing && fileRef.current?.click()}
          className={`relative rounded-xl border-2 border-dashed p-12 text-center transition-colors cursor-pointer ${
            dragging
              ? 'border-blue-400 bg-blue-50'
              : 'border-gray-300 hover:border-gray-400 hover:bg-gray-50'
          } ${isProcessing ? 'pointer-events-none opacity-60' : ''}`}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />

          {isProcessing ? (
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-10 w-10 text-blue-500 animate-spin" />
              <p className="text-sm font-medium text-gray-700">
                {jobId ? t('import.processing', { progress: progress ?? 0 }) : t('import.uploading')}
              </p>
              {jobId && (
                <div className="w-48 bg-gray-200 rounded-full h-1.5">
                  <div
                    className="bg-blue-600 h-1.5 rounded-full transition-all"
                    style={{ width: `${progress ?? 0}%` }}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-full bg-gray-100 p-4">
                <Upload className="h-8 w-8 text-gray-400" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">{t('import.dropHere')}</p>
                <p className="text-xs text-gray-500 mt-1">{t('import.orClick')}</p>
              </div>
            </div>
          )}
        </div>

        {/* Result */}
        {result && (
          <Card className="space-y-4">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-emerald-500" />
              <h2 className="text-sm font-semibold text-gray-900">{t('import.done')}</h2>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-lg bg-emerald-50 p-3 text-center">
                <p className="text-2xl font-bold text-emerald-700">{result.imported}</p>
                <p className="text-xs text-emerald-600 mt-0.5">{t('import.imported')}</p>
              </div>
              <div className="rounded-lg bg-amber-50 p-3 text-center">
                <p className="text-2xl font-bold text-amber-700">{result.skipped}</p>
                <p className="text-xs text-amber-600 mt-0.5">{t('import.skipped')}</p>
              </div>
              <div className="rounded-lg bg-red-50 p-3 text-center">
                <p className="text-2xl font-bold text-red-700">{result.errors.length}</p>
                <p className="text-xs text-red-600 mt-0.5">{t('import.errors')}</p>
              </div>
            </div>

            {result.errors.length > 0 && (
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  {t('import.errorRows')}
                </p>
                <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-200">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        {[t('import.colLine'), t('import.colNumber'), t('import.colReason')].map((h, i) => (
                          <th key={i} className="px-3 py-2 text-left font-medium text-gray-500">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {result.errors.map((e, i) => (
                        <tr key={i}>
                          <td className="px-3 py-1.5 text-gray-500">{e.row}</td>
                          <td className="px-3 py-1.5 text-gray-700">{e.phone}</td>
                          <td className="px-3 py-1.5 text-red-600">{e.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <Button onClick={() => navigate('/contacts')}>{t('import.viewContacts')}</Button>
              <Button variant="outline" icon={<FileText className="h-4 w-4" />} onClick={() => { setResult(null); fileRef.current?.click(); }}>
                {t('import.importAnother')}
              </Button>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
