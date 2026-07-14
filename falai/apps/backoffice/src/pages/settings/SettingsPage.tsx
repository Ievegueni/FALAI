import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Settings } from 'lucide-react';
import { settingsApi } from '@/lib/api';
import { Card, Button, Input, EmptyState, PageSpinner, Modal } from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';
import { ProvidersSettings, PROVIDER_KEYS } from './ProvidersSettings';

function SetModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  const mut = useMutation({
    mutationFn: () => settingsApi.set(key, value),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
      toast.success('Configuração guardada.');
      onClose();
    },
  });

  return (
    <Modal open onClose={onClose} title="Nova configuração" size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button loading={mut.isPending} onClick={() => mut.mutate()} disabled={!key.trim()}>Guardar</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Chave" placeholder="ex: MAX_CONCURRENT_CALLS" value={key} onChange={(e) => setKey(e.target.value)} required />
        <Input label="Valor" placeholder="ex: 50" value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
    </Modal>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [modal, setModal] = useState(false);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => settingsApi.list(),
  });

  const deleteMut = useMutation({
    mutationFn: (key: string) => settingsApi.delete(key),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'settings'] }); toast.success('Configuração removida.'); },
  });

  const updateMut = useMutation({
    mutationFn: ({ key, val }: { key: string; val: string }) => settingsApi.set(key, val),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
      toast.success('Actualizado.');
      setEditKey(null);
    },
  });

  if (isLoading) return <PageSpinner />;

  // A tabela genérica mostra só as chaves que não são geridas pelo formulário de provedores.
  const providerKeySet = new Set<string>(PROVIDER_KEYS);
  const entries = (data ?? []).filter((s) => !providerKeySet.has(s.key));

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Configurações do Sistema</h1>
        <p className="text-sm text-gray-500">Parâmetros globais do Falaí</p>
      </div>

      <ProvidersSettings />

      <div className="flex items-center justify-between pt-2">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Outros parâmetros</h2>
          <p className="text-sm text-gray-500">Chaves genéricas (chave/valor)</p>
        </div>
        <Button icon={<Plus className="h-4 w-4" />} onClick={() => setModal(true)}>Nova chave</Button>
      </div>

      <Card padding={false}>
        {entries.length === 0 ? (
          <EmptyState icon={<Settings className="h-8 w-8" />} title="Sem configurações definidas"
            action={{ label: 'Adicionar', onClick: () => setModal(true), icon: <Plus className="h-4 w-4" /> }} />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                {['Chave', 'Valor', 'Acções'].map((h) => (
                  <th key={h} className="px-6 py-3 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {entries.map((s) => (
                <tr key={s.key} className="hover:bg-gray-50">
                  <td className="px-6 py-3">
                    <code className="font-mono text-xs text-indigo-700">{s.key}</code>
                  </td>
                  <td className="px-6 py-3">
                    {editKey === s.key ? (
                      <div className="flex items-center gap-2">
                        <input
                          className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          value={editVal}
                          onChange={(e) => setEditVal(e.target.value)}
                          autoFocus
                        />
                        <Button size="sm" loading={updateMut.isPending} onClick={() => updateMut.mutate({ key: s.key, val: editVal })}>Guardar</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditKey(null)}>Cancelar</Button>
                      </div>
                    ) : (
                      <button
                        className="text-gray-700 hover:text-indigo-600"
                        onClick={() => { setEditKey(s.key); setEditVal(s.value); }}
                      >
                        {s.value}
                      </button>
                    )}
                  </td>
                  <td className="px-6 py-3">
                    <button
                      onClick={() => { if (confirm(`Remover "${s.key}"?`)) deleteMut.mutate(s.key); }}
                      className="text-gray-400 hover:text-red-500"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {modal && <SetModal onClose={() => setModal(false)} />}
    </div>
  );
}
