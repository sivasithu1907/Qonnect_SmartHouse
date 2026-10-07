import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, Lock } from 'lucide-react';
import { post, probe } from '../lib/api';
import { Button, inputCls, Notice } from './ui';

/** Set when an admin starts a restore in this tab (all sessions end when it completes). */
export const RESTORE_FLAG = 'qonnect.restoreStarted';

export function Login({ onLoggedIn }: { onLoggedIn: (d: any) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [maintenance, setMaintenance] = useState<string | null>(null);
  const restoreStarted = (() => { try { return sessionStorage.getItem(RESTORE_FLAG) !== null; } catch { return false; } })();
  useEffect(() => {
    void probe<{ maintenance: boolean; message: string | null }>('/api/system/status').then((r) => setMaintenance(r.body?.maintenance ? r.body.message ?? 'Maintenance in progress' : null));
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const d = await post('/api/auth/login', { email, password });
      try { sessionStorage.removeItem(RESTORE_FLAG); } catch { /* ignore */ }
      onLoggedIn(d);
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white border border-slate-200 rounded-2xl shadow-sm p-6 space-y-4">
        <div className="flex items-center gap-3">
          <img src="/qonnect-logo.png" alt="Qonnect logo" width={56} height={56} className="w-14 h-14 object-contain shrink-0" />
          <div>
            <h1 className="text-lg font-bold text-slate-900">Qonnect</h1>
            <p className="text-xs text-slate-500">Smart House project control — budget, payments & site records</p>
          </div>
        </div>
        <div>
          <label htmlFor="email" className="block text-xs font-semibold text-slate-600 mb-1">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required className={`${inputCls} min-h-11`} value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label htmlFor="password" className="block text-xs font-semibold text-slate-600 mb-1">Password</label>
          <div className="relative">
            <input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
              className={`${inputCls} min-h-11 pr-12`} value={password} onChange={(e) => setPassword(e.target.value)} />
            {/* type="button" so it never submits; the value stays as typed */}
            <button type="button" onClick={() => setShowPassword((v) => !v)} aria-controls="password" aria-pressed={showPassword}
              aria-label={showPassword ? 'Hide password' : 'Show password'} title={showPassword ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-0 w-11 flex items-center justify-center rounded-r-lg text-slate-500 hover:text-slate-800">
              {showPassword ? <EyeOff className="w-[18px] h-[18px]" aria-hidden="true" /> : <Eye className="w-[18px] h-[18px]" aria-hidden="true" />}
            </button>
          </div>
        </div>
        {maintenance && <Notice tone="amber">{maintenance}</Notice>}
        {!maintenance && restoreStarted && <Notice tone="sky">A restore from a backup was started in this browser. If it has finished, sign in with an account from the restored backup.</Notice>}
        {err && <Notice tone="rose">{err}</Notice>}
        <Button type="submit" variant="primary" className="w-full" busy={busy}><Lock className="w-3.5 h-3.5" />Sign in</Button>
        <p className="text-[11px] text-slate-400 text-center">Accounts are created by an administrator.</p>
      </form>
    </div>
  );
}
