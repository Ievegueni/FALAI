import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Phone, PhoneCall, User, Stethoscope, Save } from 'lucide-react';
import { contactsApi } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { PageSpinner } from '@/components/ui/Spinner';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  callStatusLabel,
  callStatusColor,
  formatDate,
  formatDuration,
  formatPhone,
} from '@/lib/utils';

// Contrato dos campos clínicos guardados em Contact.attributes (ver melhorias.md §5)
const CLINIC_FIELDS: { key: string; label: string; type: 'text' | 'date' | 'textarea' }[] = [
  { key: 'nrProcesso', label: 'Nº de processo', type: 'text' },
  { key: 'dataNascimento', label: 'Data de nascimento', type: 'date' },
  { key: 'ultimaConsulta', label: 'Última consulta', type: 'date' },
  { key: 'proximaConsulta', label: 'Próxima consulta', type: 'date' },
  { key: 'medicoResponsavel', label: 'Médico responsável', type: 'text' },
  { key: 'alergias', label: 'Alergias', type: 'text' },
  { key: 'notas', label: 'Notas clínicas', type: 'textarea' },
];

export function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { tenant } = useAuth();
  const { success, error } = useToast();

  const clinicEnabled = tenant?.plan?.clinicEnabled === true;

  const { data: contact, isLoading } = useQuery({
    queryKey: ['contact', id],
    queryFn: () => contactsApi.get(id!),
  });

  const [fields, setFields] = useState<Record<string, string>>({});

  // Sincroniza o formulário quando o contacto carrega
  useEffect(() => {
    if (contact) setFields({ ...(contact.attributes ?? {}) });
  }, [contact]);

  const save = useMutation({
    mutationFn: () => contactsApi.update(id!, { attributes: fields }),
    onSuccess: () => {
      success('Ficha actualizada');
      void qc.invalidateQueries({ queryKey: ['contact', id] });
    },
    onError: (e: Error) => error(e.message),
  });

  if (isLoading) return <><Header title="Contacto" /><PageSpinner /></>;
  if (!contact) return <><Header title="Contacto" /><div className="p-6 text-sm text-gray-500">Contacto não encontrado.</div></>;

  return (
    <>
      <Header
        title="Ficha do contacto"
        actions={
          <div className="flex items-center gap-2">
            {!contact.optedOutAt && (
              <Button
                size="sm"
                icon={<PhoneCall className="h-3.5 w-3.5" />}
                onClick={() => navigate('/calls/direct', { state: { to: contact.phone } })}
              >
                Ligar
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => navigate('/contacts')}>
              Voltar
            </Button>
          </div>
        }
      />

      <div className="p-6 max-w-3xl space-y-6">
        {/* Cabeçalho do contacto */}
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100">
                <User className="h-6 w-6 text-gray-500" />
              </div>
              <div>
                <p className="text-lg font-semibold text-gray-900">{contact.name}</p>
                <p className="text-sm text-gray-500 flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5 text-gray-400" />
                  {formatPhone(contact.phone)}
                </p>
              </div>
            </div>
            {contact.optedOutAt ? (
              <Badge className="bg-red-100 text-red-700">Opt-out</Badge>
            ) : (
              <Badge className="bg-emerald-100 text-emerald-700">Activo</Badge>
            )}
          </div>
        </Card>

        {/* Ficha clínica — apenas com a licença de Clínica */}
        {clinicEnabled && (
          <Card>
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Stethoscope className="h-4 w-4 text-teal-600" /> Ficha clínica
            </h2>
            <div className="grid grid-cols-2 gap-4">
              {CLINIC_FIELDS.map((f) => (
                <div key={f.key} className={f.type === 'textarea' ? 'col-span-2' : ''}>
                  {f.type === 'textarea' ? (
                    <Textarea
                      label={f.label}
                      rows={3}
                      value={fields[f.key] ?? ''}
                      onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
                    />
                  ) : (
                    <Input
                      label={f.label}
                      type={f.type}
                      value={fields[f.key] ?? ''}
                      onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <Button
                size="sm"
                icon={<Save className="h-3.5 w-3.5" />}
                loading={save.isPending}
                onClick={() => save.mutate()}
              >
                Guardar ficha
              </Button>
            </div>
          </Card>
        )}

        {/* Histórico de chamadas */}
        <Card padding={false}>
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-sm font-semibold text-gray-900">Histórico de chamadas</h2>
          </div>
          {!contact.calls || contact.calls.length === 0 ? (
            <div className="py-10 text-center text-sm text-gray-500">Ainda não há chamadas para este contacto.</div>
          ) : (
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Estado', 'Resultado', 'Duração', 'Data'].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {contact.calls.map((c) => (
                  <tr
                    key={c.id}
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => navigate(`/calls/${c.id}`)}
                  >
                    <td className="px-4 py-3">
                      <Badge className={callStatusColor[c.status]}>{callStatusLabel[c.status]}</Badge>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {c.outcome ? <span className="truncate max-w-[160px] block">{c.outcome}</span> : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {c.durationSecs !== null ? formatDuration(c.durationSecs) : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">{formatDate(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
