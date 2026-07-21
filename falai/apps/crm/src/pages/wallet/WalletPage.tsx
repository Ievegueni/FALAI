import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Wallet, CreditCard, ArrowUpRight, ArrowDownLeft, Clock, Download } from 'lucide-react';
import { walletApi, billingApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { PageSpinner } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { useToast } from '@/contexts/ToastContext';
import { formatAOA, formatDate, transactionTypeLabel } from '@/lib/utils';
import type { TransactionType } from '@/types';

const TOPUP_AMOUNTS = [5000_00, 10000_00, 20000_00, 50000_00];

function TopupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { success, error } = useToast();
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState<{ reference: string; entity: string; expiresAt: string } | null>(null);

  const topup = useMutation({
    mutationFn: () => walletApi.topup(Math.round(parseFloat(amount.replace(',', '.')) * 100)),
    onSuccess: (res) => {
      setReference({ reference: res.reference, entity: res.entity, expiresAt: res.expiresAt });
    },
    onError: (e: Error) => error(e.message),
  });

  function handleClose() {
    setAmount('');
    setReference(null);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t('wallet.topupTitle')}
      size="sm"
      footer={
        !reference ? (
          <>
            <Button variant="ghost" onClick={handleClose}>{t('common.cancel')}</Button>
            <Button loading={topup.isPending} onClick={() => topup.mutate()}>
              {t('wallet.generateRef')}
            </Button>
          </>
        ) : (
          <Button onClick={handleClose}>{t('common.close')}</Button>
        )
      }
    >
      {!reference ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            {TOPUP_AMOUNTS.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setAmount((a / 100).toFixed(2))}
                className={`rounded-lg border p-2.5 text-sm font-medium transition-colors ${
                  amount === (a / 100).toFixed(2)
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                {formatAOA(a)}
              </button>
            ))}
          </div>
          <Input
            label={t('wallet.amountLabel')}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={t('wallet.amountPlaceholder')}
            hint={t('wallet.amountMin')}
          />
        </div>
      ) : (
        <div className="text-center space-y-4">
          <div className="rounded-xl bg-blue-50 border border-blue-200 p-6">
            <p className="text-xs text-blue-600 mb-1">{t('wallet.refMulticaixa')}</p>
            <p className="text-3xl font-bold text-blue-900 tracking-widest">{reference.reference}</p>
            <p className="text-sm text-blue-700 mt-2">{t('wallet.entity')}: <strong>{reference.entity}</strong></p>
          </div>
          <p className="text-xs text-gray-500">
            {t('wallet.refInstructions', { date: formatDate(reference.expiresAt) })}
          </p>
          <p className="text-xs text-gray-400">
            {t('wallet.refSupport')} <strong>+244 924 572 875</strong>
          </p>
        </div>
      )}
    </Modal>
  );
}

const txIcon: Record<TransactionType, typeof ArrowUpRight> = {
  TOPUP: ArrowUpRight,
  CALL_CHARGE: ArrowDownLeft,
  SMS_CHARGE: ArrowDownLeft,
  REFUND: ArrowUpRight,
  ADJUSTMENT: ArrowUpRight,
  MONTHLY_FEE: ArrowDownLeft,
};

const txColor: Record<TransactionType, string> = {
  TOPUP: 'text-emerald-600 bg-emerald-50',
  CALL_CHARGE: 'text-red-600 bg-red-50',
  SMS_CHARGE: 'text-red-600 bg-red-50',
  REFUND: 'text-emerald-600 bg-emerald-50',
  ADJUSTMENT: 'text-blue-600 bg-blue-50',
  MONTHLY_FEE: 'text-orange-600 bg-orange-50',
};

export function WalletPage() {
  const { t } = useTranslation();
  const [showTopup, setShowTopup] = useState(false);
  const [page, setPage] = useState(1);

  const { data: wallet, isLoading: loadingWallet } = useQuery({
    queryKey: ['wallet', 'balance'],
    queryFn: walletApi.balance,
    refetchInterval: 15_000,
  });

  const { data: txs, isLoading: loadingTxs } = useQuery({
    queryKey: ['wallet', 'transactions', page],
    queryFn: () => walletApi.transactions({ page }),
  });

  const { data: billing } = useQuery({ queryKey: ['billing'], queryFn: billingApi.get });

  const sub = billing?.subscription;
  const subBadge =
    sub?.status === 'SUSPENDED'
      ? { text: t('wallet.subSuspended'), cls: 'bg-red-100 text-red-700' }
      : sub?.status === 'PAST_DUE'
        ? { text: t('wallet.subPastDue'), cls: 'bg-amber-100 text-amber-700' }
        : { text: t('wallet.subActive'), cls: 'bg-green-100 text-green-700' };

  return (
    <>
      <Header
        title={t('wallet.title')}
        actions={
          <Button size="sm" icon={<CreditCard className="h-3.5 w-3.5" />} onClick={() => setShowTopup(true)}>
            {t('wallet.topup')}
          </Button>
        }
      />

      <div className="p-6 space-y-6">
        {sub && sub.monthlyFeeCents > 0 && (
          <Card>
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-sm font-semibold text-gray-900">{t('wallet.subscription', { plan: sub.planName })}</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {t('wallet.perMonth', { value: formatAOA(sub.monthlyFeeCents) })}
                  {sub.nextBillingAt && ` · ${t('wallet.nextCharge', { date: formatDate(sub.nextBillingAt) })}`}
                </p>
              </div>
              <Badge className={subBadge.cls}>{subBadge.text}</Badge>
            </div>
            {billing && billing.invoices.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-gray-100">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">{t('wallet.invPeriod')}</th>
                      <th className="px-4 py-2 text-left font-medium">{t('wallet.invAmount')}</th>
                      <th className="px-4 py-2 text-left font-medium">{t('wallet.invStatus')}</th>
                      <th className="px-4 py-2 text-left font-medium">{t('wallet.invDate')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {billing.invoices.map((inv) => (
                      <tr key={inv.id}>
                        <td className="px-4 py-2 text-gray-700">{inv.period}</td>
                        <td className="px-4 py-2 text-gray-700">{formatAOA(inv.amountCents)}</td>
                        <td className="px-4 py-2">
                          <Badge className={inv.status === 'PAID' ? 'bg-green-100 text-green-700' : inv.status === 'DUE' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}>
                            {inv.status === 'PAID' ? t('wallet.invPaid') : inv.status === 'DUE' ? t('wallet.invDue') : t('wallet.invVoid')}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 text-gray-500">{formatDate(inv.paidAt ?? inv.issuedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-gray-400">{t('wallet.noInvoices')}</p>
            )}
          </Card>
        )}
        {loadingWallet ? (
          <PageSpinner />
        ) : wallet ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card className="sm:col-span-1">
              <div className="flex items-center gap-3 mb-3">
                <div className="rounded-lg bg-blue-50 p-2 text-blue-600">
                  <Wallet className="h-5 w-5" />
                </div>
                <p className="text-sm font-medium text-gray-700">{t('wallet.balanceAvailable')}</p>
              </div>
              <p className="text-3xl font-bold text-gray-900">{formatAOA(wallet.balanceCents)}</p>
              {wallet.creditLimitCents > 0 && (
                <p className="text-xs text-gray-400 mt-1">
                  {t('wallet.credit', { value: formatAOA(wallet.creditLimitCents) })}
                </p>
              )}
              <Button className="mt-4 w-full" size="sm" onClick={() => setShowTopup(true)} icon={<CreditCard className="h-3.5 w-3.5" />}>
                {t('wallet.topupShort')}
              </Button>
            </Card>

            <Card>
              <p className="text-xs text-gray-500 mb-1">{t('wallet.currentPlan')}</p>
              <p className="text-lg font-bold text-gray-900">{wallet.plan.name}</p>
              <p className="text-sm text-gray-600 mt-1">{t('wallet.perMinute', { value: formatAOA(wallet.plan.pricePerMinuteCents) })}</p>
            </Card>

            <Card>
              <p className="text-xs text-gray-500 mb-1">{t('wallet.changePlanTitle')}</p>
              <p className="text-sm text-gray-700 mt-1">{t('wallet.changePlanDesc')}</p>
              <p className="text-sm font-medium text-blue-600 mt-2">+244 924 572 875</p>
            </Card>
          </div>
        ) : null}

        {/* Transactions */}
        <Card padding={false}>
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">{t('wallet.statement')}</h2>
            <Button size="sm" variant="outline" icon={<Download className="h-3.5 w-3.5" />}>
              {t('wallet.exportCsv')}
            </Button>
          </div>

          {loadingTxs ? (
            <div className="p-8"><PageSpinner /></div>
          ) : txs?.data.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-500">{t('wallet.noTransactions')}</div>
          ) : (
            <>
              <div className="divide-y divide-gray-100">
                {txs?.data.map((tx) => {
                  const Icon = txIcon[tx.type];
                  const isDebit = ['CALL_CHARGE', 'MONTHLY_FEE'].includes(tx.type);
                  return (
                    <div key={tx.id} className="flex items-center gap-4 px-6 py-3">
                      <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${txColor[tx.type]}`}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900">{transactionTypeLabel(tx.type)}</p>
                        {tx.note && <p className="text-xs text-gray-400 truncate">{tx.note}</p>}
                        <p className="text-xs text-gray-400 flex items-center gap-1">
                          <Clock className="h-3 w-3" /> {formatDate(tx.createdAt)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-semibold ${isDebit ? 'text-red-600' : 'text-emerald-600'}`}>
                          {isDebit ? '-' : '+'}{formatAOA(Math.abs(tx.amountCents))}
                        </p>
                        <p className="text-xs text-gray-400">{formatAOA(tx.balanceAfterCents)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              {txs && <Pagination page={page} total={txs.total} perPage={txs.perPage} onPage={setPage} />}
            </>
          )}
        </Card>
      </div>

      <TopupModal open={showTopup} onClose={() => setShowTopup(false)} />
    </>
  );
}
