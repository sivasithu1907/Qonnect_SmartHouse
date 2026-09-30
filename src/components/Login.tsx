import React, { useState } from 'react';
import { Lock } from 'lucide-react';
import { post } from '../lib/api';
import { Button, inputCls, Notice } from './ui';

export function Login({ onLoggedIn }: { onLoggedIn: (d: any) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onLoggedIn(await post('/api/auth/login', { email, password }));
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
          <input id="email" type="email" autoComplete="username" required className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label htmlFor="password" className="block text-xs font-semibold text-slate-600 mb-1">Password</label>
          <input id="password" type="password" autoComplete="current-password" required className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {err && <Notice tone="rose">{err}</Notice>}
        <Button type="submit" variant="primary" className="w-full" busy={busy}><Lock className="w-3.5 h-3.5" />Sign in</Button>
        <p className="text-[11px] text-slate-400 text-center">Accounts are created by an administrator.</p>
      </form>
    </div>
  );
}
