import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Lock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Button, Input } from '@/components/ui';

export function LoginPage() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await login(email, password);
      if (res.requiresTwoFactor) {
        navigate('/2fa');
      } else {
        navigate('/dashboard');
      }
    } catch {
      toast.error('Credenciais inválidas.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 flex flex-col items-center">
        <div className="mb-4 inline-flex items-center justify-center rounded-xl bg-white px-5 py-3 shadow-lg">
          <img src="/logo.png" alt="Comunica" className="h-10 w-auto" />
        </div>
        <h1 className="text-xl font-bold text-white">Falaí Backoffice</h1>
        <p className="mt-1 text-sm text-slate-400">Acesso reservado a COMUNICA</p>
      </div>

      <div className="rounded-xl bg-white p-8 shadow-2xl">
        <form onSubmit={(e) => { void handleSubmit(e); }} className="flex flex-col gap-4">
          <Input
            label="Email"
            type="email"
            placeholder="admin@comunica.ao"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            icon={<Mail className="h-4 w-4" />}
            required
            autoFocus
          />
          <Input
            label="Password"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            icon={<Lock className="h-4 w-4" />}
            required
          />
          <Button type="submit" loading={loading} className="mt-2 w-full" size="lg">
            Entrar
          </Button>
        </form>
      </div>
    </div>
  );
}
