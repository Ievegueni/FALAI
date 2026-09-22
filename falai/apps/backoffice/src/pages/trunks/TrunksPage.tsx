import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Radio, X, Server, ServerOff, RefreshCw, Loader2, PhoneCall } from 'lucide-react';
import { trunksApi, testCallApi, tenantsApi, type TrunkInput, type TestCallResult } from '@/lib/api';
import { Card, Button, PageSpinner, EmptyState, Modal, Input, Select, Badge } from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';
import type { Trunk } from '@/types';

const DEFAULT_CODECS = ['ulaw', 'alaw', 'g729', 'g726', 'g722', 'gsm'];

function TrunkModal({ trunk, onClose }: { trunk?: Trunk; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  // Lista de clientes: alimenta o selector ao criar e, ao editar, serve para
  // mostrar o NOME do dono em vez do id — a rota dos trunks só devolve o
  // tenantId, não o nome.
  const { data: tenantPage } = useQuery({
    queryKey: ['admin', 'tenants', 'for-trunk'],
    queryFn: () => tenantsApi.list({ perPage: 100, status: 'ACTIVE' }),
  });
  const ownerName = trunk?.tenantId
    ? (tenantPage?.data.find((t) => t.id === trunk.tenantId)?.name ?? trunk.tenantId)
    : 'Partilhado (do operador)';

  const [form, setForm] = useState({
    name: trunk?.name ?? '',
    tenantId: trunk?.tenantId ?? '',
    enabled: trunk?.enabled ?? true,
    type: trunk?.type ?? 'REGISTER',
    transport: trunk?.transport ?? 'UDP',
    host: trunk?.host ?? '',
    port: String(trunk?.port ?? 5060),
    domain: trunk?.domain ?? '',
    authUser: trunk?.authUser ?? '',
    authName: trunk?.authName ?? '',
    authSecret: '',
    codecs: (trunk?.codecs?.length ? trunk.codecs : DEFAULT_CODECS).join(', '),
    maxConcurrent: trunk?.maxConcurrent != null ? String(trunk.maxConcurrent) : '',
  });
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const mut = useMutation({
    mutationFn: () => {
      const body: TrunkInput = {
        name: form.name,
        enabled: form.enabled,
        type: form.type as Trunk['type'],
        transport: form.transport as Trunk['transport'],
        host: form.host,
        port: Number(form.port) || 5060,
        domain: form.domain || null,
        authUser: form.authUser,
        authName: form.authName || null,
        codecs: form.codecs.split(',').map((c) => c.trim()).filter(Boolean),
        maxConcurrent: form.maxConcurrent ? Number(form.maxConcurrent) : null,
        ...(form.authSecret ? { authSecret: form.authSecret } : {}),
        // Só na criação, e só se houver dono escolhido: a rota de update não
        // aceita mudança de dono, e mandar o campo vazio tornaria partilhado
        // um trunk que é de um cliente.
        ...(!trunk && form.tenantId ? { tenantId: form.tenantId } : {}),
      };
      return trunk ? trunksApi.update(trunk.id, body) : trunksApi.create(body);
    },
    onSuccess: () => {
      toast.success(trunk ? 'Trunk actualizado.' : 'Trunk criado.');
      void qc.invalidateQueries({ queryKey: ['admin', 'trunks'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title={trunk ? `Editar trunk — ${trunk.name}` : 'Novo trunk'} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={mut.isPending} onClick={() => mut.mutate()}>Guardar</Button></>}>
      <div className="grid grid-cols-2 gap-4">
        <Input label="Nome" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="TESTE.ANGOLA.AGV" />
        <Select label="Estado" value={form.enabled ? '1' : '0'} onChange={(e) => set('enabled', e.target.value === '1')}>
          <option value="1">Activado</option>
          <option value="0">Desactivado</option>
        </Select>
        {trunk ? (
          <Input
            label="Cliente dono"
            value={ownerName}
            readOnly
            hint="não se muda depois de criado"
          />
        ) : (
          <Select
            label="Cliente dono"
            value={form.tenantId}
            onChange={(e) => set('tenantId', e.target.value)}
            hint={
              form.type === 'PEER' && !form.tenantId
                ? 'Num peering, sem dono não sabemos de quem é a chamada que entra'
                : 'vazio = trunk partilhado do operador'
            }
          >
            <option value="">Partilhado (do operador)</option>
            {tenantPage?.data.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </Select>
        )}
        <Select label="Tipo" value={form.type} onChange={(e) => set('type', e.target.value)}>
          <option value="REGISTER">Trunk de registo</option>
          <option value="PEER">Peer (IP-to-IP)</option>
        </Select>
        <Select label="Transporte" value={form.transport} onChange={(e) => set('transport', e.target.value)}>
          <option value="UDP">UDP</option>
          <option value="TCP">TCP</option>
          <option value="TLS">TLS</option>
        </Select>
        <Input label="Host / IP" value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="87.238.224.117" />
        <Input label="Porta" value={form.port} onChange={(e) => set('port', e.target.value)} placeholder="5060" />
        <Input label="Domínio" value={form.domain} onChange={(e) => set('domain', e.target.value)} hint="opcional" />
        <Input label="Concorrência máx." value={form.maxConcurrent} onChange={(e) => set('maxConcurrent', e.target.value)} hint="vazio = ilimitado" />
        <Input label="Utilizador (auth)" value={form.authUser} onChange={(e) => set('authUser', e.target.value)} placeholder="878029113001" />
        <Input label="Nome de autenticação" value={form.authName} onChange={(e) => set('authName', e.target.value)} hint="opcional" />
        <Input label={trunk ? 'Segredo (deixar vazio p/ manter)' : 'Segredo'} type="password" value={form.authSecret} onChange={(e) => set('authSecret', e.target.value)} />
        <Input label="Codecs (ordem)" className="col-span-2" value={form.codecs} onChange={(e) => set('codecs', e.target.value)} hint="separados por vírgula" />
      </div>
    </Modal>
  );
}

function DidsModal({ trunk, onClose }: { trunk: Trunk; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [did, setDid] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'trunks'] });

  const add = useMutation({
    mutationFn: () => trunksApi.addDid(trunk.id, did.trim()),
    onSuccess: () => { toast.success('DID adicionado.'); setDid(''); void refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (didId: string) => trunksApi.removeDid(trunk.id, didId),
    onSuccess: () => { void refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title={`DIDs — ${trunk.name}`} footer={<Button onClick={onClose}>Fechar</Button>}>
      <div className="space-y-3">
        <div className="flex gap-2 items-end">
          <Input label="Novo DID" value={did} onChange={(e) => setDid(e.target.value)} placeholder="244959100354" className="flex-1" />
          <Button loading={add.isPending} disabled={!did.trim()} onClick={() => add.mutate()}>Adicionar</Button>
        </div>
        <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {trunk.dids.length === 0 && <p className="px-3 py-4 text-sm text-gray-400 text-center">Sem DIDs.</p>}
          {trunk.dids.map((d) => (
            <div key={d.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="font-mono">{d.did}</span>
              <button onClick={() => remove.mutate(d.id)} className="text-red-500 hover:text-red-600"><X className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Estado do motor SIP próprio (Asterisk) e do registo do trunk na operadora.
 * É o indicador "registado / não registado" pedido pela ANGOVOIP.
 * Actualiza sozinho a cada 15s.
 */
function EngineStatusCard() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'trunks', 'engine-status'],
    queryFn: trunksApi.engineStatus,
    refetchInterval: 15_000,
  });

  if (isLoading) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" /> A verificar o motor SIP…
        </div>
      </Card>
    );
  }

  // Motor inacessível ou por configurar — informativo, não é erro do utilizador.
  if (!data?.engineReachable) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <ServerOff className="h-5 w-5 text-gray-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-700">Motor SIP próprio indisponível</p>
            <p className="text-xs text-gray-500 mt-0.5">{data?.error ?? 'Sem resposta do motor.'}</p>
            <p className="text-xs text-gray-400 mt-1">
              As chamadas continuam a passar pelo PBX externo. Ver <code className="bg-gray-100 px-1 rounded">infra/asterisk/README.md</code>.
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void refetch()} icon={<RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />} />
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-indigo-500" />
          <h2 className="text-sm font-semibold text-gray-700">Motor SIP próprio</h2>
          {data.version && <Badge className="bg-gray-100 text-gray-600 text-xs">Asterisk {data.version}</Badge>}
        </div>
        <div className="flex items-center gap-3">
          {data.activeCalls != null && (
            <span className="text-xs text-gray-500">{data.activeCalls} chamada{data.activeCalls === 1 ? '' : 's'} activa{data.activeCalls === 1 ? '' : 's'}</span>
          )}
          <Button size="sm" variant="ghost" onClick={() => void refetch()} icon={<RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />} />
        </div>
      </div>

      {data.trunks.length === 0 && data.peers.length === 0 ? (
        <p className="text-xs text-gray-500">O motor está a correr mas não tem nenhum trunk configurado.</p>
      ) : (
        <div className="space-y-2">
          {data.trunks.map((t) => {
            const ok = t.status === 'REGISTERED';
            const unknown = t.status === 'UNKNOWN';
            return (
              <div key={t.name} className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${ok ? 'border-emerald-200 bg-emerald-50' : unknown ? 'border-amber-200 bg-amber-50' : 'border-red-200 bg-red-50'}`}>
                <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${ok ? 'bg-emerald-500' : unknown ? 'bg-amber-500' : 'bg-red-500'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900">{t.name}</span>
                    <span className={`text-xs font-semibold ${ok ? 'text-emerald-700' : unknown ? 'text-amber-700' : 'text-red-700'}`}>
                      {ok ? 'REGISTADO' : unknown ? 'ESTADO DESCONHECIDO' : 'NÃO REGISTADO'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">
                    {t.username && <><code className="bg-white/60 px-1 rounded">{t.username}</code> em </>}
                    {t.serverUri?.replace('sip:', '')}
                    {ok && t.expirationSecs != null && <> · renova a cada {Math.round(t.expirationSecs / 60)} min</>}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Peering (IP-to-IP). Secção à parte porque o estado NÃO é um registo:
          estes trunks não se registam. O que se mostra é a resposta ao último
          OPTIONS, que é o único sinal de vida que existe numa ligação por IP. */}
      {data.peers.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-gray-500 mb-2">
            Peering IP-to-IP <span className="font-normal text-gray-400">— sem registo; estado medido por OPTIONS a cada 60s</span>
          </p>
          <div className="space-y-2">
            {data.peers.map((p) => {
              const up = p.status === 'REACHABLE';
              const unknown = p.status === 'UNKNOWN';
              return (
                <div key={p.endpoint} className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${up ? 'border-emerald-200 bg-emerald-50' : unknown ? 'border-amber-200 bg-amber-50' : 'border-red-200 bg-red-50'}`}>
                  <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${up ? 'bg-emerald-500' : unknown ? 'bg-amber-500' : 'bg-red-500'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{p.trunkName}</span>
                      <span className={`text-xs font-semibold ${up ? 'text-emerald-700' : unknown ? 'text-amber-700' : 'text-red-700'}`}>
                        {up ? 'UP' : unknown ? 'SEM MEDIÇÃO' : 'EM BAIXO'}
                      </span>
                      {p.tenantId && <Badge className="bg-gray-100 text-gray-600 text-xs">exclusivo</Badge>}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">
                      <code className="bg-white/60 px-1 rounded">{p.host}</code>
                      {p.latencyMs != null && <> · {p.latencyMs} ms</>}
                      {!up && !unknown && <> · sem resposta ao OPTIONS — confirmar o 5060/udp do lado do cliente</>}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="text-xs text-gray-400 mt-3">
        Verificado às {new Date(data.checkedAt).toLocaleTimeString('pt-PT')} · actualiza a cada 15s
      </p>
    </Card>
  );
}

/**
 * Aceita o número como a pessoa o escreve e devolve-o em E.164, que é o que a
 * API valida. Quem está a testar escreve "923 456 789", não "+244923456789".
 */
function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (raw.trim().startsWith('+')) return `+${digits}`;
  if (digits.length === 9) return `+244${digits}`;
  if (digits.startsWith('244')) return `+${digits}`;
  return `+${digits}`;
}

function TestCallCard() {
  const toast = useToast();
  const [number, setNumber] = useState('');
  const [result, setResult] = useState<TestCallResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const dial = useMutation({
    mutationFn: () => testCallApi.dial(toE164(number)),
    onSuccess: (r) => {
      setFailure(null);
      setResult(r);
      toast.success('Chamada iniciada.');
    },
    onError: (e: Error) => {
      setResult(null);
      setFailure(e.message);
    },
  });

  const e164 = number.trim() ? toE164(number) : '';
  const valid = /^\+[1-9]\d{6,14}$/.test(e164);

  return (
    <Card>
      <div className="flex items-center gap-2 mb-1">
        <PhoneCall className="h-4 w-4 text-indigo-500" />
        <h2 className="text-sm font-semibold text-gray-700">Chamada de teste</h2>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Marca pelo caminho real — o mesmo que as campanhas e o agente de IA usam. Serve para provar
        que a plataforma telefona, não só que o trunk está registado.
      </p>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            label="Número"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && valid && !dial.isPending) dial.mutate(); }}
            placeholder="923 456 789"
          />
        </div>
        <Button
          loading={dial.isPending}
          disabled={!valid}
          icon={<PhoneCall className="h-4 w-4" />}
          onClick={() => dial.mutate()}
        >
          Ligar
        </Button>
      </div>
      {number.trim() !== '' && (
        <p className="text-xs text-gray-400 mt-1.5">
          {valid ? <>Vai marcar <code className="bg-gray-100 px-1 rounded">{e164}</code></> : 'Número incompleto.'}
        </p>
      )}

      {result && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5">
          <p className="text-sm text-emerald-800">{result.message}</p>
          <p className="text-xs text-emerald-700/70 mt-0.5">
            Canal <code>{result.providerCallId}</code> · registada em Chamadas
          </p>
        </div>
      )}

      {failure && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5">
          <p className="text-sm text-red-800">{failure}</p>
          <p className="text-xs text-red-700/70 mt-1">
            Causas comuns: número num formato que o operador não aceita (ver ASTERISK_DIAL_FORMAT),
            conta sem saldo ou sem permissão de saída, ou trunk por registar.
          </p>
        </div>
      )}
    </Card>
  );
}

export function TrunksPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Trunk | null>(null);
  const [creating, setCreating] = useState(false);
  const [dids, setDids] = useState<Trunk | null>(null);

  const { data: trunks, isLoading } = useQuery({ queryKey: ['admin', 'trunks'], queryFn: trunksApi.list });

  const remove = useMutation({
    mutationFn: (id: string) => trunksApi.delete(id),
    onSuccess: () => { toast.success('Trunk removido.'); void qc.invalidateQueries({ queryKey: ['admin', 'trunks'] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Trunks SIP</h1>
          <p className="text-sm text-gray-500">Trunks do operador e os exclusivos de cada cliente (peering IP-to-IP e BYO-PBX).</p>
        </div>
        <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>Novo trunk</Button>
      </div>

      <EngineStatusCard />

      <TestCallCard />

      {isLoading ? (
        <PageSpinner />
      ) : trunks && trunks.length > 0 ? (
        <Card padding={false}>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-400 border-b border-gray-100">
              <tr>
                <th className="px-5 py-2.5 font-medium">Nome</th>
                <th className="px-5 py-2.5 font-medium">Host</th>
                <th className="px-5 py-2.5 font-medium">Tipo</th>
                <th className="px-5 py-2.5 font-medium">Âmbito</th>
                <th className="px-5 py-2.5 font-medium">DIDs</th>
                <th className="px-5 py-2.5 font-medium">Estado</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {trunks.map((t) => (
                <tr key={t.id} className="hover:bg-gray-50">
                  <td className="px-5 py-2.5 font-medium text-gray-900">{t.name}</td>
                  <td className="px-5 py-2.5 font-mono text-xs text-gray-500">{t.transport} {t.host}:{t.port}</td>
                  <td className="px-5 py-2.5 text-gray-600">{t.type === 'REGISTER' ? 'Registo' : 'Peer'}</td>
                  <td className="px-5 py-2.5">
                    <Badge className={t.shared ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}>{t.shared ? 'Partilhado' : 'Cliente'}</Badge>
                  </td>
                  <td className="px-5 py-2.5">
                    <button className="text-xs text-blue-600 hover:underline" onClick={() => setDids(t)}>{t.dids.length} DID(s)</button>
                  </td>
                  <td className="px-5 py-2.5">
                    <Badge className={t.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}>{t.enabled ? 'Activo' : 'Inactivo'}</Badge>
                  </td>
                  {/* Antes, um trunk com dono mostrava "gerido pelo cliente" e mais
                      nada. Isso valia quando esses trunks só nasciam no CRM do
                      próprio cliente (BYO-PBX). Um cliente API_BYOM não tem CRM
                      nenhum: o trunk de peering dele é provisionado aqui, e sem
                      estes botões ficava sem ninguém que o pudesse editar. */}
                  <td className="px-5 py-2.5 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(t)} />
                      <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
                        onClick={() => {
                          const aviso = t.shared
                            ? `Eliminar o trunk ${t.name}?`
                            : `O trunk ${t.name} é de um cliente. Eliminar mesmo assim?`;
                          if (confirm(aviso)) remove.mutate(t.id);
                        }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState icon={<Radio className="h-6 w-6" />} title="Sem trunks" description="Cria o primeiro trunk." action={{ label: 'Novo trunk', onClick: () => setCreating(true) }} />
      )}

      {creating && <TrunkModal onClose={() => setCreating(false)} />}
      {editing && <TrunkModal trunk={editing} onClose={() => setEditing(null)} />}
      {dids && <DidsModal trunk={dids} onClose={() => setDids(null)} />}
    </div>
  );
}
