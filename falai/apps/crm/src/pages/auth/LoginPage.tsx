import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ApiError, authApi } from '@/lib/api';

export function LoginPage() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const { error: toastError } = useToast();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  // Endereço próprio do cliente (credito.falai.ao): mostra de quem é; desconhecido bloqueia o login.
  const [site, setSite] = useState<{ tenantName?: string; logoDataUrl?: string | null; unknown?: boolean } | null>(null);
  const [rightSite, setRightSite] = useState<string | null>(null);

  useEffect(() => {
    authApi.site()
      .then((s) => setSite(s.subdomain ? s : null))
      // Só o 404 da própria rota (traz `subdomain`) é endereço desconhecido; um 404
      // genérico (API sem esta rota) não pode bloquear o login.
      .catch((err) => { if (err instanceof ApiError && err.status === 404 && err.data.subdomain) setSite({ unknown: true }); });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setRightSite(null);
    try {
      const { requiresTwoFactor } = await login(email, password);
      if (requiresTwoFactor) {
        navigate('/2fa');
      } else {
        navigate('/dashboard');
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && typeof err.data.crmUrl === 'string') setRightSite(err.data.crmUrl);
      toastError(err instanceof ApiError ? err.message : t('login.error'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 inline-flex items-center justify-center rounded-xl bg-white px-5 py-3 shadow-lg">
          <img src={site?.logoDataUrl ?? '/logo.png'} alt={site?.tenantName ?? 'Comunica'} className="h-10 w-auto" />
        </div>
        <h1 className="text-2xl font-bold text-white">{site?.tenantName ?? 'Falaí'}</h1>
        <p className="mt-1 text-sm text-slate-400">{t('login.subtitle')}</p>
      </div>

      <div className="rounded-2xl bg-white p-8 shadow-2xl">
        {site?.unknown ? (
          <p className="text-sm text-gray-700">{t('login.unknownSite')}</p>
        ) : (
        <form onSubmit={(e) => { void handleSubmit(e); }} className="flex flex-col gap-4">
          <Input
            label={t('login.email')}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('login.emailPlaceholder')}
            required
            autoFocus
          />
          <div className="relative">
            <Input
              label={t('login.password')}
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 bottom-2 text-gray-400 hover:text-gray-600"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          <Button type="submit" loading={loading} className="mt-2 w-full h-10">
            {t('login.submit')}
          </Button>
          {rightSite && (
            <a href={rightSite} className="text-center text-sm font-medium text-indigo-600 hover:underline">
              {t('login.goToYourSite')}: {rightSite.replace(/^https?:\/\//, '')}
            </a>
          )}
        </form>
        )}
      </div>

      <p className="mt-6 text-center text-xs text-slate-500">
        {t('common.support')}: <span className="text-slate-300">+244 924 572 875</span>
      </p>
    </div>
  );
}
