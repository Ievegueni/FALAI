import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { authApi, ApiError } from '@/lib/api';

export function RegisterPage() {
  const { login: authLogin } = useAuth();
  const { error: toastError } = useToast();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    companyName: '',
    password: '',
    confirmPassword: '',
  });
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Partial<typeof form>>({});

  function set(field: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  function validate() {
    const e: Partial<typeof form> = {};
    if (!form.name.trim()) e.name = 'Nome obrigatório';
    if (!form.email.trim()) e.email = 'Email obrigatório';
    if (!form.phone.trim()) e.phone = 'Telefone obrigatório';
    if (!form.companyName.trim()) e.companyName = 'Nome da empresa obrigatório';
    if (form.password.length < 8) e.password = 'Mínimo 8 caracteres';
    if (form.password !== form.confirmPassword) e.confirmPassword = 'Palavras-passe não coincidem';
    return e;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const e2 = validate();
    if (Object.keys(e2).length > 0) {
      setErrors(e2);
      return;
    }
    setLoading(true);
    try {
      await authApi.register({
        name: form.name,
        email: form.email,
        phone: form.phone,
        companyName: form.companyName,
        password: form.password,
      });
      // Registration does not return a token; authenticate with the new credentials.
      await authLogin(form.email, form.password);
      navigate('/onboarding');
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : 'Erro ao criar conta');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600">
          <Zap className="h-6 w-6 text-white" />
        </div>
        <h1 className="text-2xl font-bold text-white">Criar conta</h1>
        <p className="mt-1 text-sm text-slate-400">Comece gratuitamente, sem cartão</p>
      </div>

      <div className="rounded-2xl bg-white p-8 shadow-2xl">
        <form onSubmit={(e) => { void handleSubmit(e); }} className="flex flex-col gap-3">
          <Input
            label="Nome completo"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            error={errors.name}
            placeholder="João Silva"
            required
            autoFocus
          />
          <Input
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            error={errors.email}
            placeholder="joao@empresa.ao"
            required
          />
          <Input
            label="Telemóvel"
            type="tel"
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
            error={errors.phone}
            placeholder="+244 9XX XXX XXX"
            required
          />
          <Input
            label="Nome da empresa"
            value={form.companyName}
            onChange={(e) => set('companyName', e.target.value)}
            error={errors.companyName}
            placeholder="Empresa, Lda"
            required
          />
          <Input
            label="Palavra-passe"
            type="password"
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
            error={errors.password}
            placeholder="Mínimo 8 caracteres"
            required
          />
          <Input
            label="Confirmar palavra-passe"
            type="password"
            value={form.confirmPassword}
            onChange={(e) => set('confirmPassword', e.target.value)}
            error={errors.confirmPassword}
            placeholder="••••••••"
            required
          />
          <Button type="submit" loading={loading} className="mt-2 w-full h-10">
            Criar conta
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-500">
          Já tem conta?{' '}
          <Link to="/login" className="font-medium text-blue-600 hover:underline">
            Entrar
          </Link>
        </p>
      </div>
    </div>
  );
}
