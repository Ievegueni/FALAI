import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, MessageCircle, Globe, Mail, Plus, Send, Trash2, Copy, ArrowUp, ArrowDown } from 'lucide-react';
import { inboxesApi, cannedApi, agentsApi, ApiError } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/contexts/ToastContext';
import type { Channel, Inbox, WaPoolStatus } from '@/types';

const channelIcon: Record<Channel, typeof Mail> = { WEBCHAT: Globe, EMAIL: Mail, TELEGRAM: Send, WHATSAPP: MessageCircle };

// Campos de config por canal. `secret` = cifrado no servidor, nunca volta ao ecrã.
const channelFields: Record<Channel, { key: string; label: string; type?: string; secret?: boolean; placeholder?: string }[]> = {
  TELEGRAM: [{ key: 'botToken', label: 'Token do bot (@BotFather)', secret: true, placeholder: '123456:ABC-DEF…' }],
  WHATSAPP: [
    { key: 'phoneNumberId', label: 'Phone number ID (Meta → WhatsApp → Configuração da API)', placeholder: '1234567890' },
    { key: 'accessToken', label: 'Access token permanente (utilizador de sistema)', secret: true, placeholder: 'EAA…' },
    { key: 'appSecret', label: 'App secret (Meta → Definições da app → Básico)', secret: true },
  ],
  WEBCHAT: [
    { key: 'title', label: 'Título do widget' },
    { key: 'welcome', label: 'Mensagem de boas-vindas' },
    { key: 'color', label: 'Cor', placeholder: '#2563eb' },
    { key: 'allowedOrigins', label: 'Sites autorizados (um por linha)', placeholder: 'https://www.exemplo.ao' },
  ],
  EMAIL: [
    { key: 'fromAddress', label: 'Endereço de envio', placeholder: 'suporte@falai.ao' },
    { key: 'replyTo', label: 'Reply-To (endereço do cliente)', placeholder: 'suporte@cliente.ao' },
    { key: 'imapHost', label: 'IMAP host' },
    { key: 'imapPort', label: 'IMAP porta', type: 'number', placeholder: '993' },
    { key: 'imapUser', label: 'IMAP utilizador' },
    { key: 'imapPass', label: 'IMAP palavra-passe', secret: true },
    { key: 'smtpHost', label: 'SMTP host' },
    { key: 'smtpPort', label: 'SMTP porta', type: 'number', placeholder: '465' },
    { key: 'smtpUser', label: 'SMTP utilizador' },
    { key: 'smtpPass', label: 'SMTP palavra-passe', secret: true },
  ],
};

function toConfig(channel: Channel, form: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of channelFields[channel]) {
    const v = form[f.key]?.trim();
    if (!v) continue;
    if (f.key === 'allowedOrigins') out[f.key] = v.split(/\s+/).filter(Boolean);
    else if (f.type === 'number') out[f.key] = Number(v);
    else out[f.key] = v;
  }
  return out;
}

function fromConfig(inbox: Inbox): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inbox.config)) out[k] = Array.isArray(v) ? v.join('\n') : String(v ?? '');
  return out;
}

export function InboxSettingsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Inbox | 'new' | null>(null);

  // Refresca para o estado do pool WhatsApp (health check corre no servidor a cada minuto).
  const { data: inboxes = [] } = useQuery({ queryKey: ['inboxes'], queryFn: inboxesApi.list, refetchInterval: 30_000 });
  const remove = useMutation({
    mutationFn: inboxesApi.remove,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['inboxes'] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Erro'),
  });

  return (
    <div>
      <Header
        title={t('inbox.channels')}
        actions={<Link to="/inbox"><Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />}>{t('nav.inbox')}</Button></Link>}
      />
      <div className="space-y-6 p-6">
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-900">{t('inbox.channels')}</h2>
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>{t('inbox.addChannel')}</Button>
          </div>
          {inboxes.length === 0 && <p className="text-sm text-gray-400">{t('inbox.noInboxesHint')}</p>}
          {inboxes.map((i) => {
            const Icon = channelIcon[i.channel];
            return (
              <div key={i.id} className="rounded-lg border border-gray-200 p-3">
                <div className="flex items-center gap-3">
                  <Icon className="h-4 w-4 text-gray-500" />
                  <span className="font-medium text-gray-900">{i.name}</span>
                  {typeof i.config['botUsername'] === 'string' && <span className="text-xs text-gray-500">@{i.config['botUsername']}</span>}
                  {typeof i.config['displayPhone'] === 'string' && (
                    <span className="text-xs text-gray-500">{i.config['displayPhone']}{typeof i.config['verifiedName'] === 'string' ? ` · ${i.config['verifiedName']}` : ''}</span>
                  )}
                  {!i.enabled && <Badge className="bg-gray-100 text-gray-600">{t('inbox.disabled')}</Badge>}
                  {i.agentId && i.autoReply && <Badge className="bg-violet-100 text-violet-700">{t('inbox.modeAi')}</Badge>}
                  <span className="ml-auto" />
                  <Button size="sm" variant="outline" onClick={() => setEditing(i)}>{t('inbox.edit')}</Button>
                  <Button size="sm" variant="ghost" aria-label={t('inbox.delete')} icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />} onClick={() => remove.mutate(i.id)} />
                </div>
                {i.webhookUrl && (
                  <div className="mt-2 space-y-1 rounded bg-gray-50 p-2 text-xs text-gray-600">
                    <p>Na app da Meta → WhatsApp → Configuração → Webhook, subscrever o campo <b>messages</b>:</p>
                    {[['URL de callback', i.webhookUrl], ['Verify token', i.verifyToken ?? '']].map(([k, v]) => (
                      <div key={k} className="flex items-center gap-2">
                        <span className="w-28 shrink-0">{k}</span>
                        <code className="flex-1 truncate">{v}</code>
                        <Button size="sm" variant="ghost" aria-label={`${t('inbox.copy')} ${k}`} icon={<Copy className="h-3.5 w-3.5" />}
                          onClick={() => void navigator.clipboard.writeText(v!).then(() => toast.success(t('inbox.copied')))} />
                      </div>
                    ))}
                  </div>
                )}
                {i.snippet && (
                  <div className="mt-2 flex items-center gap-2">
                    <code className="flex-1 truncate rounded bg-gray-50 px-2 py-1 text-xs text-gray-600">{i.snippet}</code>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t('inbox.copy')}
                      icon={<Copy className="h-3.5 w-3.5" />}
                      onClick={() => void navigator.clipboard.writeText(i.snippet!).then(() => toast.success(t('inbox.copied')))}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </Card>

        <WaPoolCard inboxes={inboxes.filter((i) => i.channel === 'WHATSAPP')} />

        <CannedCard />
      </div>

      {editing && <InboxModal inbox={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function InboxModal({ inbox, onClose }: { inbox: Inbox | null; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const [channel, setChannel] = useState<Channel>(inbox?.channel ?? 'TELEGRAM');
  const [name, setName] = useState(inbox?.name ?? '');
  const [agentId, setAgentId] = useState(inbox?.agentId ?? '');
  const [autoReply, setAutoReply] = useState(inbox?.autoReply ?? true);
  const [enabled, setEnabled] = useState(inbox?.enabled ?? true);
  const [form, setForm] = useState<Record<string, string>>(inbox ? fromConfig(inbox) : {});

  const { data: agents } = useQuery({ queryKey: ['agents', 'ACTIVE'], queryFn: () => agentsApi.list({ status: 'ACTIVE' }) });

  const save = useMutation({
    mutationFn: () => {
      const data = { name, agentId: agentId || null, autoReply, config: toConfig(channel, form) };
      return inbox ? inboxesApi.update(inbox.id, { ...data, enabled }) : inboxesApi.create({ ...data, channel });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inboxes'] });
      toast.success(t('inbox.saved'));
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Erro'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={inbox ? t('inbox.edit') : t('inbox.addChannel')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('inbox.cancel')}</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name}>{t('inbox.save')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        {!inbox && (
          <Select label={t('inbox.channel')} value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
            <option value="WHATSAPP">WhatsApp Business</option>
            <option value="TELEGRAM">Telegram</option>
            <option value="WEBCHAT">{t('inbox.webchat')}</option>
            <option value="EMAIL">Email</option>
          </Select>
        )}
        <Input label={t('inbox.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <Select label={t('inbox.agent')} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">{t('inbox.noAgent')}</option>
          {agents?.data.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={autoReply} onChange={(e) => setAutoReply(e.target.checked)} /> {t('inbox.autoReply')}
        </label>
        {inbox && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {t('inbox.enabled')}
          </label>
        )}
        {channelFields[channel].map((f) =>
          f.key === 'allowedOrigins' || f.key === 'welcome' ? (
            <Textarea key={f.key} label={f.label} rows={2} value={form[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
          ) : (
            <Input
              key={f.key}
              label={f.label}
              type={f.secret ? 'password' : f.type === 'number' ? 'number' : 'text'}
              value={form[f.key] ?? ''}
              placeholder={f.secret && inbox?.secretsSet[f.key] ? '•••••••• (definido — deixe vazio para manter)' : f.placeholder}
              autoComplete="off"
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            />
          ),
        )}
      </div>
    </Modal>
  );
}

function CannedCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const [shortcut, setShortcut] = useState('');
  const [text, setText] = useState('');
  const { data: canned = [] } = useQuery({ queryKey: ['canned'], queryFn: cannedApi.list });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['canned'] });
  const create = useMutation({
    mutationFn: () => cannedApi.create({ shortcut, text }),
    onSuccess: () => {
      setShortcut('');
      setText('');
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Erro'),
  });
  const remove = useMutation({ mutationFn: cannedApi.remove, onSuccess: refresh });

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold text-gray-900">{t('inbox.canned')}</h2>
      <p className="text-xs text-gray-500">{t('inbox.cannedHint')}</p>
      {canned.map((c) => (
        <div key={c.id} className="flex items-start gap-3 border-b border-gray-100 pb-2 text-sm">
          <span className="font-mono text-blue-600">/{c.shortcut}</span>
          <span className="flex-1 whitespace-pre-wrap text-gray-700">{c.text}</span>
          <Button size="sm" variant="ghost" aria-label={t('inbox.delete')} icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />} onClick={() => remove.mutate(c.id)} />
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-2">
        <Input label={t('inbox.shortcut')} value={shortcut} onChange={(e) => setShortcut(e.target.value)} placeholder="horario" className="w-40" />
        <div className="min-w-[240px] flex-1">
          <Input label={t('inbox.cannedText')} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <Button onClick={() => create.mutate()} disabled={!shortcut || !text} loading={create.isPending}>{t('inbox.add')}</Button>
      </div>
    </Card>
  );
}

const poolBadge: Record<WaPoolStatus, string> = {
  ACTIVE: 'bg-green-100 text-green-700',
  DEGRADED: 'bg-amber-100 text-amber-700',
  STANDBY: 'bg-blue-100 text-blue-700',
  FAILED: 'bg-red-100 text-red-700',
  DISABLED: 'bg-gray-100 text-gray-600',
};

function WaPoolCard({ inboxes }: { inboxes: Inbox[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['inboxes'] });
  const onError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Erro');
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'activate' | 'standby' | 'disable' | 'check' }) => inboxesApi.poolAction(id, action),
    onSuccess: (r) => {
      if ('verdict' in r) toast.success(`${r.verdict}: ${r.detail}`);
      refresh();
    },
    onError,
  });
  const order = useMutation({ mutationFn: inboxesApi.poolOrder, onSuccess: refresh, onError });

  if (!inboxes.length) return null;
  const sorted = [...inboxes].sort((a, b) => (a.pool?.priority ?? 999) - (b.pool?.priority ?? 999));
  const inService = sorted.some((i) => i.pool?.status === 'ACTIVE' || i.pool?.status === 'DEGRADED');
  const move = (idx: number, dir: -1 | 1) => {
    const ids = sorted.map((i) => i.id);
    [ids[idx], ids[idx + dir]] = [ids[idx + dir]!, ids[idx]!];
    order.mutate(ids);
  };
  const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : '—');
  const link = sorted[0]!.poolUrl ?? '';

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold text-gray-900">{t('inbox.waPool')}</h2>
      <p className="text-xs text-gray-500">{t('inbox.waPoolHint')}</p>
      <div className="flex items-center gap-2 rounded bg-gray-50 p-2 text-xs text-gray-600">
        <span className="shrink-0">{t('inbox.waPoolLink')}</span>
        <code className="flex-1 truncate">{link}</code>
        <Button size="sm" variant="ghost" aria-label={t('inbox.copy')} icon={<Copy className="h-3.5 w-3.5" />}
          onClick={() => void navigator.clipboard.writeText(link).then(() => toast.success(t('inbox.copied')))} />
      </div>
      {!inService && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{t('inbox.waPoolNone')}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-gray-500">
            <tr>
              <th className="py-1 pr-2">#</th>
              <th className="pr-2">{t('inbox.name')}</th>
              <th className="pr-2">Estado</th>
              <th className="pr-2">{t('inbox.waLastCheck')}</th>
              <th className="pr-2">{t('inbox.waLastError')}</th>
              <th className="pr-2">{t('inbox.waStatusAt')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map((i, idx) => {
              const st = i.pool?.status;
              const busy = act.isPending || order.isPending;
              return (
                <tr key={i.id} className="border-t border-gray-100 align-top">
                  <td className="py-2 pr-2 text-gray-500">{i.pool?.priority ?? '—'}</td>
                  <td className="pr-2">
                    <div className="font-medium text-gray-900">{i.name}</div>
                    <div className="text-xs text-gray-500">{String(i.config['displayPhone'] ?? '')}</div>
                  </td>
                  <td className="pr-2">
                    {st ? <Badge className={poolBadge[st]}>{st}</Badge> : '—'}
                    {!i.enabled && <div className="text-xs text-gray-400">{t('inbox.disabled')}</div>}
                  </td>
                  <td className="pr-2 text-xs text-gray-600">{fmt(i.pool?.lastCheckAt)}</td>
                  <td className="max-w-[220px] pr-2 text-xs text-gray-600" title={i.pool?.lastError ?? ''}>
                    <span className="line-clamp-2">{i.pool?.lastError ?? '—'}</span>
                  </td>
                  <td className="pr-2 text-xs text-gray-600">{fmt(i.pool?.statusAt)}</td>
                  <td className="whitespace-nowrap">
                    <Button size="sm" variant="ghost" aria-label={t('inbox.waMoveUp')} disabled={busy || idx === 0} icon={<ArrowUp className="h-3.5 w-3.5" />} onClick={() => move(idx, -1)} />
                    <Button size="sm" variant="ghost" aria-label={t('inbox.waMoveDown')} disabled={busy || idx === sorted.length - 1} icon={<ArrowDown className="h-3.5 w-3.5" />} onClick={() => move(idx, 1)} />
                    {st !== 'ACTIVE' && st !== 'DEGRADED' && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => act.mutate({ id: i.id, action: 'activate' })}>{t('inbox.waActivate')}</Button>
                    )}
                    {st !== 'STANDBY' && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => act.mutate({ id: i.id, action: 'standby' })}>{t('inbox.waStandby')}</Button>
                    )}
                    {st !== 'DISABLED' && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => act.mutate({ id: i.id, action: 'disable' })}>{t('inbox.waDisable')}</Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => act.mutate({ id: i.id, action: 'check' })}>{t('inbox.waCheck')}</Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
