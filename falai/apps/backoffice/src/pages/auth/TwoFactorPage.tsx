import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui';

export function TwoFactorPage() {
  const navigate = useNavigate();
  const { verify2fa } = useAuth();
  const toast = useToast();
  const [digits, setDigits] = useState(Array(6).fill(''));
  const [loading, setLoading] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  // 2FA obrigatória e ainda por activar: o login deixou aqui o QR e a chave.
  const [setup] = useState<{ secret: string; qrCode: string } | null>(() => {
    try { return JSON.parse(sessionStorage.getItem('falai_admin_2fa_setup') ?? 'null'); } catch { return null; }
  });

  function handleChange(idx: number, val: string) {
    if (!/^\d*$/.test(val)) return;
    const next = [...digits];
    next[idx] = val.slice(-1);
    setDigits(next);
    if (val && idx < 5) inputRefs.current[idx + 1]?.focus();
    if (next.every((d) => d !== '')) void submit(next.join(''));
  }

  function handleKeyDown(idx: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && !digits[idx] && idx > 0) {
      inputRefs.current[idx - 1]?.focus();
    }
  }

  async function submit(code: string) {
    setLoading(true);
    try {
      await verify2fa(code);
      navigate('/dashboard');
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Código inválido ou expirado.');
      setDigits(Array(6).fill(''));
      inputRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="rounded-xl bg-white p-8 shadow-2xl">
        <div className="mb-6 flex flex-col items-center">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <h2 className="text-lg font-semibold text-gray-900">{setup ? 'Active a verificação em 2 passos' : 'Verificação 2FA'}</h2>
          <p className="mt-1 text-sm text-gray-500 text-center">
            {setup
              ? 'É obrigatória no backoffice. Leia o código QR com uma app de autenticação (Google Authenticator, Microsoft Authenticator…) e introduza o código de 6 dígitos.'
              : 'Insira o código da sua aplicação autenticadora'}
          </p>
        </div>

        {setup && (
          <div className="mb-6 text-center">
            <img src={setup.qrCode} alt="QR 2FA" className="mx-auto h-44 w-44" />
            <p className="mt-3 text-xs text-gray-500">Ou introduza esta chave na app:</p>
            <code className="mt-1 block break-all font-mono text-sm text-gray-900 select-all">{setup.secret}</code>
          </div>
        )}

        <div className="flex justify-center gap-2 mb-6">
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => { inputRefs.current[i] = el; }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={d}
              onChange={(e) => handleChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              className="h-12 w-10 rounded-lg border border-gray-300 text-center text-lg font-bold text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              autoFocus={i === 0}
            />
          ))}
        </div>

        <Button
          loading={loading}
          onClick={() => void submit(digits.join(''))}
          disabled={digits.some((d) => d === '')}
          className="w-full"
          size="lg"
        >
          Verificar
        </Button>
      </div>
    </div>
  );
}
