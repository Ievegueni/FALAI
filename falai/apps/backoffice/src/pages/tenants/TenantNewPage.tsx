import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { tenantsApi, plansApi } from '@/lib/api';
import { Card, Button, Input, Select, PageSpinner } from '@/components/ui';
import { useToast } from '@/contexts/ToastContext';

export function TenantNewPage() {
  const navigate = useNavigate();
  const toast = useToast();

  const [form, setForm] = useState({
    name: '', email: '', phone: '', nif: '', planId: '',
    ownerName: '', ownerEmail: '', ownerPassword: '',
  });

  const { data: plans, isLoading } = useQuery({
    queryKey: ['admin', 'plans'],
    queryFn: () => plansApi.list(),
  });

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const createMut = useMutation({
    mutationFn: () =>
      tenantsApi.create({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        ...(form.nif.trim() ? { nif: form.nif.trim() } : {}),
        planId: form.planId,
        ownerName: form.ownerName.trim(),
        ownerEmail: form.ownerEmail.trim(),
        ownerPassword: form.ownerPassword,
      }),
    onSuccess: (t) => {
      toast.success('Tenant criado.');
      navigate(`/tenants/${t.id}`);
    },
    onError: (e: Error) => toast.error(e.message || 'Erro ao criar tenant.'),
  });

  const valid =
    form.name.trim().length >= 2 &&
    /.+@.+\..+/.test(form.email) &&
    form.phone.trim().length >= 7 &&
    !!form.planId &&
    form.ownerName.trim().length >= 2 &&
    /.+@.+\..+/.test(form.ownerEmail) &&
    form.ownerPassword.length >= 8;

  if (isLoading) return <PageSpinner />;

  return (
    <div className="p-6 space-y-5 max-w-2xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => navigate('/tenants')}>
          Voltar
        </Button>
        <h1 className="text-xl font-bold text-gray-900">Novo tenant</h1>
      </div>

      <Card>
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Organização</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Nome" placeholder="ex: ACME Lda" value={form.name} onChange={set('name')} />
          <Input label="NIF (opcional)" placeholder="ex: 5000000000" value={form.nif} onChange={set('nif')} />
          <Input label="Email" type="email" placeholder="geral@acme.ao" value={form.email} onChange={set('email')} />
          <Input label="Telefone" placeholder="+244923000000" value={form.phone} onChange={set('phone')} />
          <div className="sm:col-span-2">
            <Select label="Plano" value={form.planId} onChange={set('planId')}>
              <option value="">Seleccionar plano…</option>
              {(plans ?? []).filter((p) => p.isActive).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.productType === 'VOICE_AI' ? 'Voice AI' : 'CRM BYO-PBX'}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Utilizador proprietário</h2>
        <p className="text-xs text-gray-500 mb-4">Primeira conta de acesso ao CRM deste cliente (role OWNER).</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Nome" placeholder="ex: João Silva" value={form.ownerName} onChange={set('ownerName')} />
          <Input label="Email de acesso" type="email" placeholder="joao@acme.ao" value={form.ownerEmail} onChange={set('ownerEmail')} />
          <div className="sm:col-span-2">
            <Input label="Palavra-passe" type="password" placeholder="mínimo 8 caracteres" value={form.ownerPassword} onChange={set('ownerPassword')} hint="O cliente pode alterá-la depois." />
          </div>
        </div>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate('/tenants')}>Cancelar</Button>
        <Button loading={createMut.isPending} disabled={!valid} onClick={() => createMut.mutate()}>
          Criar tenant
        </Button>
      </div>
    </div>
  );
}
