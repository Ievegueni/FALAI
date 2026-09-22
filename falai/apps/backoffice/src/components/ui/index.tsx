import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, useEffect } from 'react';
import { Loader2, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { clsx } from '@/lib/utils';

// ─── Button ──────────────────────────────────────────────────────────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg';

const variantClass: Record<Variant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-500',
  secondary: 'bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-gray-400',
  ghost: 'text-gray-600 hover:bg-gray-100 focus:ring-gray-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500',
  outline: 'border border-gray-300 text-gray-700 hover:bg-gray-50 focus:ring-gray-400',
};
const sizeClass: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-6 text-sm gap-2',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = 'primary', size = 'md', loading = false, icon, children, className, disabled, ...props }: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed',
        variantClass[variant], sizeClass[size], className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

// ─── Input ───────────────────────────────────────────────────────────────────

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  icon?: ReactNode;
}

export function Input({ label, error, hint, icon, className, id, ...props }: InputProps) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
          {label}{props.required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      )}
      <div className="relative">
        {icon && <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">{icon}</div>}
        <input
          id={inputId}
          className={clsx(
            'block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400',
            'focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500',
            'disabled:bg-gray-50 disabled:cursor-not-allowed',
            error && 'border-red-500 focus:border-red-500 focus:ring-red-500',
            icon !== undefined && 'pl-9',
            className,
          )}
          {...props}
        />
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {hint && !error && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export function Textarea({ label, error, hint, className, id, ...props }: TextareaProps) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
  return (
    <div className="flex flex-col gap-1">
      {label && <label htmlFor={inputId} className="text-sm font-medium text-gray-700">{label}</label>}
      <textarea
        id={inputId}
        className={clsx(
          'block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 resize-y min-h-[80px]',
          'focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500',
          error && 'border-red-500',
          className,
        )}
        {...props}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      {hint && !error && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

interface SelectProps extends InputHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  /** Nota por baixo do campo, como no Input e no Textarea. */
  hint?: string;
  children: ReactNode;
}

export function Select({ label, error, hint, className, id, children, ...props }: SelectProps) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
  return (
    <div className="flex flex-col gap-1">
      {label && <label htmlFor={inputId} className="text-sm font-medium text-gray-700">{label}</label>}
      <select
        id={inputId}
        className={clsx(
          'block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900',
          'focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500',
          error && 'border-red-500',
          className,
        )}
        {...(props as TextareaHTMLAttributes<HTMLSelectElement>)}
      >
        {children}
      </select>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {hint && !error && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

// ─── Badge ───────────────────────────────────────────────────────────────────

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', className)}>
      {children}
    </span>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

export function Card({ children, className, padding = true }: { children: ReactNode; className?: string; padding?: boolean }) {
  return (
    <div className={clsx('rounded-xl border border-gray-200 bg-white shadow-sm', padding && 'p-6', className)}>
      {children}
    </div>
  );
}

export function StatCard({ label, value, sub, icon, trend, className }: {
  label: string; value: string | number; sub?: string; icon?: ReactNode;
  trend?: { positive: boolean; label: string }; className?: string;
}) {
  return (
    <Card className={clsx('flex items-start gap-4', className)}>
      {icon && <div className="rounded-lg bg-indigo-50 p-2.5 text-indigo-600">{icon}</div>}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-500 truncate">{label}</p>
        <p className="mt-1 text-2xl font-bold text-gray-900 truncate">{value}</p>
        {sub && <p className="mt-0.5 text-xs text-gray-400">{sub}</p>}
        {trend && (
          <p className={`mt-1 text-xs font-medium ${trend.positive ? 'text-emerald-600' : 'text-red-600'}`}>
            {trend.label}
          </p>
        )}
      </div>
    </Card>
  );
}

// ─── Modal ───────────────────────────────────────────────────────────────────

export function Modal({ open, onClose, title, children, size = 'md', footer }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl'; footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', h); document.body.style.overflow = ''; };
  }, [open, onClose]);

  if (!open) return null;
  const sizeClass = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative w-full ${sizeClass} max-h-[90vh] flex flex-col rounded-xl bg-white shadow-2xl`}>
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer && <div className="border-t border-gray-200 px-6 py-4 flex justify-end gap-3">{footer}</div>}
      </div>
    </div>
  );
}

// ─── Spinner ─────────────────────────────────────────────────────────────────

export function Spinner({ size = 'md', className }: { size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const s = { sm: 'h-4 w-4', md: 'h-6 w-6', lg: 'h-8 w-8' }[size];
  return <Loader2 className={clsx('animate-spin text-indigo-600', s, className)} />;
}

export function PageSpinner() {
  return <div className="flex h-64 items-center justify-center"><Spinner size="lg" /></div>;
}

// ─── EmptyState ──────────────────────────────────────────────────────────────

export function EmptyState({ icon, title, description, action }: {
  icon?: ReactNode; title: string; description?: string;
  action?: { label: string; onClick: () => void; icon?: ReactNode };
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      {icon && <div className="mb-4 rounded-full bg-gray-100 p-4 text-gray-400">{icon}</div>}
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      {description && <p className="mt-1 text-sm text-gray-500 max-w-sm">{description}</p>}
      {action && (
        <div className="mt-4">
          <Button onClick={action.onClick} icon={action.icon}>{action.label}</Button>
        </div>
      )}
    </div>
  );
}

// ─── Pagination ──────────────────────────────────────────────────────────────

export function Pagination({ page, total, perPage, onPage }: {
  page: number; total: number; perPage: number; onPage: (p: number) => void;
}) {
  const totalPages = Math.ceil(total / perPage);
  if (totalPages <= 1) return null;
  const from = (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, total);

  return (
    <div className="flex items-center justify-between border-t border-gray-200 px-4 py-3">
      <p className="text-sm text-gray-500">{from}–{to} de {total}</p>
      <div className="flex items-center gap-1">
        <button onClick={() => onPage(page - 1)} disabled={page === 1} className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-40">
          <ChevronLeft className="h-5 w-5" />
        </button>
        {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
          const p = totalPages <= 7 ? i + 1 : page <= 4 ? i + 1 : page >= totalPages - 3 ? totalPages - 6 + i : page - 3 + i;
          return (
            <button key={p} onClick={() => onPage(p)} className={`min-w-[32px] rounded px-2 py-1 text-sm ${p === page ? 'bg-indigo-600 text-white font-medium' : 'text-gray-600 hover:bg-gray-100'}`}>{p}</button>
          );
        })}
        <button onClick={() => onPage(page + 1)} disabled={page === totalPages} className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-40">
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

export function Tabs({ tabs, active, onChange }: {
  tabs: { key: string; label: string; badge?: number }[];
  active: string;
  onChange: (k: string) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-gray-200">
      {tabs.map((tab) => (
        <button key={tab.key} onClick={() => onChange(tab.key)}
          className={clsx(
            'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
            active === tab.key ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700',
          )}
        >
          {tab.label}
          {tab.badge !== undefined && tab.badge > 0 && (
            <span className="rounded-full bg-red-100 text-red-600 text-xs px-1.5 py-0.5 font-medium">{tab.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}
