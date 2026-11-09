import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { tenantsApi } from '@/lib/api';
import { Button, Input, Select } from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';

interface Row { name: string; limit: string }

interface Props {
  tenantId: string;
  maxConcurrent: number;
  lineGroupLimits: Record<string, number>;
  defaultLineGroup: string | null;
  onSaved: () => void;
}

/**
 * Grupos de linhas: divide as chamadas simultâneas do cliente por tipo de
 * campanha (ex.: 6 cobrança + 6 marketing). Cada campanha escolhe o grupo
 * (`lineGroup` na API); as que não escolhem vão para o grupo por omissão.
 */
export function TenantLineGroups({ tenantId, maxConcurrent, lineGroupLimits, defaultLineGroup, onSaved }: Props) {
  const toast = useToast();
  const fromProps = () => Object.entries(lineGroupLimits).map(([name, limit]) => ({ name, limit: String(limit) }));
  const [rows, setRows] = useState<Row[]>(fromProps);
  const [def, setDef] = useState(defaultLineGroup ?? '');

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setRows(fromProps()); setDef(defaultLineGroup ?? ''); }, [JSON.stringify(lineGroupLimits), defaultLineGroup]);

  const saveMut = useMutation({
    mutationFn: (body: { lineGroupLimits: Record<string, number> | null; defaultLineGroup: string | null }) =>
      tenantsApi.update(tenantId, body as never),
    onSuccess: () => { onSaved(); toast.success('Grupos de linhas actualizados.'); },
    onError: (e: Error) => toast.error(e.message || 'Erro ao gravar os grupos.'),
  });

  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase().replace(/\s+/g, '_');
  const names = rows.map((r) => norm(r.name)).filter(Boolean);
  const total = rows.reduce((acc, r) => acc + (parseInt(r.limit, 10) || 0), 0);

  const save = () => {
    const limits: Record<string, number> = {};
    for (const r of rows) {
      const name = norm(r.name);
      if (!name) continue;
      const n = parseInt(r.limit, 10);
      if (Number.isNaN(n) || n < 1 || n > 50) { toast.error(`Limite inválido no grupo ${name} (1 a 50).`); return; }
      limits[name] = n;
    }
    const empty = Object.keys(limits).length === 0;
    const defaultName = !empty && def && limits[norm(def)] !== undefined ? norm(def) : null;
    saveMut.mutate({ lineGroupLimits: empty ? null : limits, defaultLineGroup: defaultName });
  };

  return (
    <div className="flex flex-col gap-2 border-t border-gray-100 pt-3">
      <div className="flex justify-between items-center">
        <dt className="text-gray-500">Grupos de linhas</dt>
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus className="h-4 w-4" />}
          onClick={() => setRows([...rows, { name: '', limit: '1' }])}
        >
          Grupo
        </Button>
      </div>
      {rows.length === 0 && (
        <p className="text-xs text-gray-400">Sem grupos: todas as campanhas partilham as {maxConcurrent} linhas.</p>
      )}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            className="flex-1"
            placeholder="COBRANCA"
            value={r.name}
            onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
          />
          <Input
            type="number"
            min={1}
            max={50}
            className="w-20 text-right"
            value={r.limit}
            onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, limit: e.target.value } : x)))}
          />
          <Button variant="ghost" size="sm" icon={<Trash2 className="h-4 w-4" />} onClick={() => setRows(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      {rows.length > 0 && (
        <>
          <Select label="Grupo das campanhas sem grupo" value={def} onChange={(e) => setDef(e.target.value)}>
            <option value="">Nenhum (só o limite total)</option>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
          {total > maxConcurrent && (
            <p className="text-xs text-amber-600">
              A soma dos grupos ({total}) passa o limite total do cliente ({maxConcurrent}). O total continua a valer, por isso
              um grupo pode ficar sem linhas quando os outros estão cheios.
            </p>
          )}
        </>
      )}
      <div className="flex justify-end">
        <Button size="sm" loading={saveMut.isPending} onClick={save}>Gravar grupos</Button>
      </div>
    </div>
  );
}
