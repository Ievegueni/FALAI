import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, CheckCircle2, AlertTriangle, FileWarning } from 'lucide-react';
import { contactsApi, type ContactFileResult } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { formatPhone } from '@/lib/utils';

/**
 * Carregar um ficheiro de números para uma campanha (voz ou SMS). O servidor
 * reconhece os contactos que já existem pelo número (não os grava de novo),
 * cria só os que faltam e devolve-os todos para a campanha.
 */
export function ContactFileUpload({ onResolved }: { onResolved: (r: ContactFileResult) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ContactFileResult | null>(null);
  const [fileName, setFileName] = useState('');

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const r = await contactsApi.fromFile(file);
      setResult(r);
      setFileName(file.name);
      onResolved(r);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('contactFile.error'));
    } finally {
      setBusy(false);
    }
  };

  const s = result?.summary;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-3">
        <input
          ref={ref}
          type="file"
          accept=".csv,.txt,.xlsx,.xls"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }}
        />
        <Button type="button" size="sm" variant="outline" icon={<Upload className="h-3.5 w-3.5" />} loading={busy} onClick={() => ref.current?.click()}>
          {t('contactFile.upload')}
        </Button>
        <p className="min-w-0 flex-1 text-xs text-gray-500">{t('contactFile.hint')}</p>
      </div>

      {s && (
        <div className="rounded-lg border border-gray-200 p-3 text-sm">
          <p className="mb-2 flex items-center gap-2 font-medium text-gray-900">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            {t('contactFile.done', { file: fileName, count: s.valid })}
          </p>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600 sm:grid-cols-4">
            <li>{t('contactFile.existing', { count: s.existing })}</li>
            <li>{t('contactFile.created', { count: s.created })}</li>
            <li>{t('contactFile.duplicates', { count: s.duplicatesInFile })}</li>
            <li className={s.invalid ? 'text-red-600' : ''}>{t('contactFile.invalid', { count: s.invalid })}</li>
          </ul>

          {result.invalid.length > 0 && (
            <details className="mt-2 text-xs">
              <summary className="flex cursor-pointer items-center gap-1 text-red-600">
                <FileWarning className="h-3.5 w-3.5" /> {t('contactFile.seeInvalid')}
              </summary>
              <ul className="mt-1 max-h-32 overflow-y-auto pl-5 text-gray-600">
                {result.invalid.map((i) => (
                  <li key={i.row}>{t('contactFile.line', { row: i.row })}: “{i.raw}” — {i.reason}</li>
                ))}
              </ul>
            </details>
          )}

          {result.nameMatches.length > 0 && (
            <details className="mt-2 text-xs">
              <summary className="flex cursor-pointer items-center gap-1 text-amber-700">
                <AlertTriangle className="h-3.5 w-3.5" /> {t('contactFile.nameMatches', { count: result.nameMatches.length })}
              </summary>
              <p className="mt-1 text-gray-500">{t('contactFile.nameMatchesHint')}</p>
              <ul className="mt-1 max-h-32 overflow-y-auto pl-5 text-gray-600">
                {result.nameMatches.map((m) => (
                  <li key={m.row}>
                    {m.name}: {formatPhone(m.phone)} — {t('contactFile.alreadyWith', { phone: formatPhone(m.existingPhone) })}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
