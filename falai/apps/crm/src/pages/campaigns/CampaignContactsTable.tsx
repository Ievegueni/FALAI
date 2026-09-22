import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, Search, Trash2, Phone } from 'lucide-react';
import { Link } from 'react-router-dom';
import { campaignsApi } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Pagination } from '@/components/ui/Pagination';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import { formatDuration, formatAOA, formatPhone } from '@/lib/utils';
import type { CampaignContactRow, CampaignContactStatus } from '@/types';

const PER_PAGE = 50;

const statusColor: Record<CampaignContactStatus, string> = {
  PENDING: 'bg-gray-100 text-gray-700',
  QUEUED: 'bg-blue-100 text-blue-700',
  IN_PROGRESS: 'bg-amber-100 text-amber-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-700',
  OPTED_OUT: 'bg-purple-100 text-purple-700',
  SKIPPED: 'bg-gray-100 text-gray-500',
};

/**
 * Lista nominal dos participantes da campanha. Responde à pergunta que os
 * cartões agregados não respondem: "este cliente atendeu, falhou, ou ainda nem
 * foi tentado — e porquê?".
 */
export function CampaignContactsTable({ campaignId, campaignName }: { campaignId: string; campaignName: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { success, error } = useToast();

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['campaigns', campaignId, 'contacts', page, status, search],
    queryFn: () =>
      campaignsApi.contacts(campaignId, {
        page,
        ...(status ? { status } : {}),
        ...(search ? { search } : {}),
      }),
  });

  const remove = useMutation({
    mutationFn: (contactId: string) => campaignsApi.removeContact(campaignId, contactId),
    onSuccess: () => {
      success(t('campaigns.contacts.removed'));
      void qc.invalidateQueries({ queryKey: ['campaigns', campaignId] });
    },
    onError: (e: Error) => error(e.message),
  });

  const exportCsv = useMutation({
    mutationFn: () => campaignsApi.exportContactsCsv(campaignId, campaignName),
    onError: (e: Error) => error(e.message),
  });

  return (
    <Card padding={false}>
      <div className="flex flex-wrap items-end gap-3 p-4 border-b border-gray-200">
        <h2 className="text-sm font-semibold text-gray-900 mr-auto">{t('campaigns.contacts.title')}</h2>

        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setSearch(searchInput.trim());
          }}
        >
          <Input
            placeholder={t('campaigns.contacts.searchPlaceholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            icon={<Search className="h-4 w-4" />}
            className="w-48"
          />
          <Select
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value);
            }}
            className="w-40"
          >
            <option value="">{t('campaigns.contacts.allStatuses')}</option>
            {(Object.keys(statusColor) as CampaignContactStatus[]).map((s) => (
              <option key={s} value={s}>
                {t(`campaigns.contacts.status.${s}`)}
              </option>
            ))}
          </Select>
        </form>

        <Button
          size="sm"
          variant="ghost"
          icon={<Download className="h-3.5 w-3.5" />}
          loading={exportCsv.isPending}
          onClick={() => exportCsv.mutate()}
        >
          {t('campaigns.contacts.exportCsv')}
        </Button>
      </div>

      {isLoading ? (
        <div className="p-8 flex justify-center">
          <Spinner />
        </div>
      ) : !data || data.contacts.length === 0 ? (
        <p className="p-8 text-center text-sm text-gray-500">{t('campaigns.contacts.empty')}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {[
                    t('campaigns.contacts.colContact'),
                    t('campaigns.contacts.colStatus'),
                    t('campaigns.contacts.colAttempts'),
                    t('campaigns.contacts.colResult'),
                    t('campaigns.contacts.colDuration'),
                    t('campaigns.contacts.colCost'),
                    '',
                  ].map((h, i) => (
                    <th key={i} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.contacts.map((row) => (
                  <ContactRow
                    key={row.id}
                    row={row}
                    onRemove={() => remove.mutate(row.contactId)}
                    removing={remove.isPending && remove.variables === row.contactId}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} total={data.total} perPage={PER_PAGE} onPage={setPage} />
        </>
      )}
    </Card>
  );
}

function ContactRow({
  row,
  onRemove,
  removing,
}: {
  row: CampaignContactRow;
  onRemove: () => void;
  removing: boolean;
}) {
  const { t } = useTranslation();

  // O que interessa ao utilizador não é o código técnico, é a frase: atendeu,
  // não atendeu, ou falhou por este motivo.
  const result =
    row.failReason ??
    row.outcome ??
    (row.status === 'COMPLETED'
      ? t('campaigns.contacts.answered')
      : row.status === 'OPTED_OUT'
        ? row.optOutReason ?? t('campaigns.contacts.status.OPTED_OUT')
        : row.status === 'PENDING' && row.nextRetryAt
          ? t('campaigns.contacts.retryScheduled')
          : '—');

  return (
    <tr className="hover:bg-gray-50">
      <td className="px-4 py-2.5">
        <p className="text-sm text-gray-900">{row.name ?? '—'}</p>
        <p className="text-xs text-gray-500">{formatPhone(row.phone)}</p>
      </td>
      <td className="px-4 py-2.5">
        <Badge className={statusColor[row.status]}>{t(`campaigns.contacts.status.${row.status}`)}</Badge>
      </td>
      <td className="px-4 py-2.5 text-sm text-gray-600">{row.attempts}</td>
      <td className="px-4 py-2.5 text-sm text-gray-600 max-w-xs truncate" title={result}>
        {result}
      </td>
      <td className="px-4 py-2.5 text-sm text-gray-600">
        {row.durationSecs === null ? '—' : formatDuration(row.durationSecs)}
      </td>
      <td className="px-4 py-2.5 text-sm text-gray-600">
        {row.costCents === null ? '—' : formatAOA(row.costCents)}
      </td>
      <td className="px-4 py-2.5 text-right whitespace-nowrap">
        {row.callId && (
          <Link
            to={`/calls/${row.callId}`}
            className="inline-flex items-center text-gray-400 hover:text-blue-600 p-1"
            title={t('campaigns.contacts.viewCall')}
          >
            <Phone className="h-4 w-4" />
          </Link>
        )}
        {/* Só quem ainda não foi contactado pode sair: apagar um já contactado
            perderia o histórico da chamada. */}
        {row.status === 'PENDING' && (
          <button
            onClick={() => {
              if (confirm(t('campaigns.contacts.removeConfirm'))) onRemove();
            }}
            disabled={removing}
            className="inline-flex items-center text-gray-400 hover:text-red-600 p-1 disabled:opacity-40"
            title={t('campaigns.contacts.remove')}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </td>
    </tr>
  );
}
