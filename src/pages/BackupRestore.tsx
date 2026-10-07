import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, DatabaseBackup, Download, FileSearch, Lock, PauseCircle, PlayCircle, RefreshCw, ShieldAlert, Trash2, Upload, XCircle,
} from 'lucide-react';
import { ApiError, get, post, probe, putBinary } from '../lib/api';
import { useApi } from '../lib/hooks';
import { formatDateTime } from '../lib/format';
import { BACKUP_COUNT_LABELS, BACKUP_KIND_LABELS } from '../../shared/backup';
import { Badge, Button, Card, EmptyState, inputCls, Modal, Notice, PageHeader, Spinner, Table, Td, Th, useUi } from '../components/ui';
import { RESTORE_FLAG } from '../components/Login';
import { useWideLayout } from '../components/materials/MaterialCategorySection';

// ---- server shapes (see server/backup/*)
interface Operation { id: string; kind: 'backup' | 'validate' | 'restore'; backupId: string | null; state: 'running' | 'succeeded' | 'failed'; phase: string; done: number | null; total: number | null; startedAt: string; finishedAt: string | null; by: string | null; error: string | null; result: any }
interface Status {
  operation: Operation | null; maintenance: string | null; jobsPaused: boolean; pausedReason: string | null; pausedAt: string | null;
  lastRestore: { id: string; at: string; backupCreatedAt: string | null; by: string | null } | null;
  storage: { problem: string | null; freeBytes: number | null };
  limits: { maxUploadBytes: number; chunkBytes: number; retention: number };
  app: { version: string; commit: string; schema: string | null };
  previousDatabase: string | null;
  current: Record<string, number> | null;
}
interface Validation {
  ok: boolean; errors: string[]; warnings: string[]; checkedAt: string; archiveBytes: number;
  manifest: null | { backupId: string; createdAt: string; createdBy: { email: string | null; name: string | null } | null; source: string; formatVersion: number; app: { version: string; commit: string }; schemaLatest: string | null; postgres: string; complete: boolean; encryption: string };
  compatibility: { compatible: boolean; status: string; pendingMigrations: string[]; message: string };
  counts: Record<string, number>; projects: Array<{ id: string; code: string; name: string; archived: boolean }>; users: number; tables: number;
  attachments: { rows: number; filesIncluded: number; bytes: number; missing: number; mismatched: number };
}
interface BackupMeta {
  id: string; kind: string; status: string; createdAt: string; finishedAt: string | null; createdBy: { email: string | null; name: string | null } | null;
  fileName: string; size: number | null; backupCreatedAt: string | null; appVersion: string | null; commit: string | null; schemaVersion: string | null;
  complete: boolean | null; attachments: { rows: number; filesIncluded: number; bytes: number; missing: number } | null; error: string | null;
  warnings: string[]; validation: Validation | null; restoredAt: string | null;
}

const bytes = (n: number | null | undefined) => n == null ? '—' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
const RESTORABLE = ['verified', 'incomplete', 'valid'];

function StatusBadge({ m }: { m: BackupMeta }) {
  const map: Record<string, [string, 'emerald' | 'amber' | 'rose' | 'sky' | 'slate']> = {
    verified: ['Verified', 'emerald'], incomplete: ['Incomplete', 'amber'], failed: ['Failed', 'rose'], running: ['Creating…', 'sky'],
    uploaded: ['Not validated', 'slate'], validating: ['Validating…', 'sky'], valid: ['Valid', 'emerald'], invalid: ['Rejected', 'rose'],
  };
  const [label, tone] = map[m.status] ?? [m.status, 'slate'];
  return <Badge tone={tone}>{label}</Badge>;
}

function ProgressBar({ done, total }: { done: number | null; total: number | null }) {
  const pct = done && total ? Math.min(100, Math.round((done / total) * 100)) : null;
  return (
    <div className="h-2 rounded-full bg-slate-100 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
      <div className={`h-full bg-sky-500 ${pct === null ? 'w-1/3 animate-pulse' : ''}`} style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

/** Settings → Backup & Restore (administrators only). */
export function BackupRestore() {
  const { data: status, reload: reloadStatus } = useApi<Status>('/api/admin/backup/status');
  const { data: list, error, reload: reloadList } = useApi<{ backups: BackupMeta[] }>('/api/admin/backup/backups');
  const [review, setReview] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ name: string; sent: number; size: number; error?: string } | null>(null);
  const [restoring, setRestoring] = useState<{ opId: string; phase: string; done: number | null; total: number | null; finished?: 'signed-out' | 'failed'; error?: string } | null>(null);
  const [lastSeenOp, setLastSeenOp] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast, confirm } = useUi();
  const running = status?.operation?.state === 'running';
  const wide = useWideLayout();

  // poll while an operation runs
  useEffect(() => {
    if (!running || restoring) return; // during a restore only the sign-out-safe probe below polls
    const t = setInterval(() => { void reloadStatus(); }, 1200);
    return () => clearInterval(t);
  }, [running, restoring, reloadStatus]);
  // when an operation finishes: refresh the list once and report the result
  useEffect(() => {
    const op = status?.operation;
    if (!op || op.state === 'running' || op.id === lastSeenOp) return;
    setLastSeenOp(op.id);
    void reloadList();
    if (lastSeenOp !== null || Date.now() - new Date(op.finishedAt ?? 0).getTime() < 5000) {
      if (op.kind === 'validate' && op.state === 'succeeded' && op.backupId) setReview(op.backupId);
      if (op.state === 'failed') toast(op.error ?? 'The operation failed', 'error');
      else if (op.kind === 'backup') toast('Backup created and verified');
    }
  }, [status, lastSeenOp, reloadList, toast]);

  const createBackup = async () => {
    try { await post('/api/admin/backup/backups'); await reloadStatus(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setUpload({ name: f.name, sent: 0, size: f.size });
    try {
      const init = await post<{ upload: { id: string }; chunkBytes: number }>('/api/admin/backup/uploads', { fileName: f.name, size: f.size });
      const id = init.upload.id;
      let offset = 0;
      let failures = 0;
      while (offset < f.size) {
        const r = await putBinary(`/api/admin/backup/uploads/${id}?offset=${offset}`, f.slice(offset, offset + init.chunkBytes)).catch(() => ({ status: 0, body: null as any }));
        if (r.status === 200) { offset = r.body.received; failures = 0; }
        else if (r.status === 409 && typeof r.body?.received === 'number') { offset = r.body.received; }
        else {
          if (++failures > 5) throw new Error(r.body?.error ?? 'The upload keeps failing. Check the connection and try again.');
          await new Promise((res) => setTimeout(res, 1000 * failures));
          const cur = await get<{ upload: { received: number } }>(`/api/admin/backup/uploads/${id}`).catch(() => null);
          if (cur) offset = cur.upload.received;
        }
        setUpload({ name: f.name, sent: offset, size: f.size });
      }
      await post(`/api/admin/backup/uploads/${id}/complete`);
      setUpload(null);
      toast('Upload complete — validating the archive. Nothing has been changed.');
      await Promise.all([reloadStatus(), reloadList()]);
    } catch (ex) {
      setUpload((u) => (u ? { ...u, error: (ex as Error).message } : u));
    }
  };

  const startRestore = async (m: BackupMeta, password: string, confirmation: string) => {
    const r = await post<{ operation: Operation }>(`/api/admin/backup/backups/${m.id}/restore`, { password, confirmation });
    setReview(null);
    try { sessionStorage.setItem(RESTORE_FLAG, r.operation.id); } catch { /* ignore */ }
    setRestoring({ opId: r.operation.id, phase: 'Starting', done: null, total: null });
  };

  // restore progress: poll without the sign-out handler; sessions are cleared at the end
  useEffect(() => {
    if (!restoring || restoring.finished) return;
    const t = setInterval(async () => {
      const s = await probe<Status>('/api/admin/backup/status');
      if (s.status === 200 && s.body) {
        const op = s.body.operation;
        if (op && op.id === restoring.opId) {
          if (op.state === 'running') setRestoring((r) => (r ? { ...r, phase: op.phase, done: op.done, total: op.total } : r));
          else if (op.state === 'failed') {
            try { sessionStorage.removeItem(RESTORE_FLAG); } catch { /* ignore */ }
            setRestoring((r) => (r ? { ...r, finished: 'failed', error: op.error ?? 'Restore failed' } : r)); void reloadStatus(); void reloadList();
          }
        }
      } else if (s.status === 401) {
        setRestoring((r) => (r ? { ...r, finished: 'signed-out' } : r));
      }
    }, 1500);
    return () => clearInterval(t);
  }, [restoring, reloadStatus, reloadList]);

  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!status || !list) return <Spinner />;
  const op = status.operation;
  const reviewed = list.backups.find((b) => b.id === review) ?? null;
  const actions = (m: BackupMeta) => (
    <>
                    {['verified', 'incomplete', 'valid', 'uploaded', 'invalid'].includes(m.status) && (
                      <a className="inline-flex p-1.5 text-slate-500 hover:text-sky-700" href={`/api/admin/backup/backups/${m.id}/download`} aria-label={`Download ${m.fileName}`} title="Download"><Download className="w-4 h-4" /></a>
                    )}
                    {m.validation && <button type="button" className="p-1.5 text-slate-500 hover:text-sky-700" aria-label="Review" title="Review details" onClick={() => setReview(m.id)}><FileSearch className="w-4 h-4" /></button>}
                    {['verified', 'incomplete', 'valid', 'uploaded', 'invalid'].includes(m.status) && (
                      <button type="button" className="p-1.5 text-slate-500 hover:text-sky-700 disabled:opacity-40" disabled={running} aria-label="Validate again" title="Validate again"
                        onClick={async () => { try { await post(`/api/admin/backup/backups/${m.id}/validate`); await reloadStatus(); } catch (e) { toast((e as Error).message, 'error'); } }}><RefreshCw className="w-4 h-4" /></button>
                    )}
                    <button type="button" className="p-1.5 text-slate-400 hover:text-rose-600 disabled:opacity-40" disabled={running} aria-label={`Delete ${m.fileName}`} title="Delete archive"
                      onClick={async () => {
                        if (!(await confirm(<>Delete the archive <b>{m.fileName}</b> from the server? Live data and uploaded files are not affected. Keep a downloaded copy if you may need it.</>, { title: 'Delete backup archive', confirmLabel: 'Delete', danger: true }))) return;
                        try { await post(`/api/admin/backup/backups/${m.id}/delete`); await reloadList(); } catch (e) { toast((e as Error).message, 'error'); }
                      }}><Trash2 className="w-4 h-4" /></button>
                  </>
  );

  return (
    <div className="space-y-6">
      <PageHeader icon={<DatabaseBackup className="w-5 h-5" />} title="Backup & restore"
        subtitle="Full backups of every project, record, user and uploaded file — to recover on a new server if this one fails. Administrators only." />

      {status.storage.problem && <Notice tone="rose" title="Backup storage is not available">{status.storage.problem} See docs/BACKUP_RESTORE.md (“Backup storage permissions”).</Notice>}

      {status.jobsPaused && (
        <Card className="border-amber-300 bg-amber-50/60">
          <div className="flex flex-wrap items-start gap-3">
            <PauseCircle className="w-6 h-6 text-amber-600 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1 space-y-2 text-sm text-amber-950">
              <p className="font-bold">Background jobs and notifications are paused</p>
              <p className="text-xs">{status.pausedReason}</p>
              {status.lastRestore && <p className="text-xs">Last restore: {formatDateTime(status.lastRestore.at)} from the backup of {formatDateTime(status.lastRestore.backupCreatedAt)}{status.lastRestore.by ? ` (by ${status.lastRestore.by})` : ''}.</p>}
              <div className="text-xs">
                <p className="font-semibold">Recovery checks before resuming</p>
                <ol className="list-decimal ml-5 space-y-0.5">
                  <li>Open each project: budget, payments (totals), contracts, materials and timeline look right.</li>
                  <li>Open a few attachments (payment slips, signed contracts) to confirm files open.</li>
                  <li>Users &amp; access: accounts and project assignments are as expected.</li>
                  <li>Check the domain / HTTPS and that sign-in works for other users.</li>
                  <li>Tell users to sign in again and re-enable push notifications on each device (Notifications page).</li>
                </ol>
              </div>
            </div>
            <Button variant="primary" onClick={async () => {
              if (!(await confirm('Resume due-date checks and push notifications? Old notifications are not re-sent.', { title: 'Resume background jobs', confirmLabel: 'Resume' }))) return;
              try { await post('/api/admin/backup/jobs/resume'); toast('Background jobs resumed'); await reloadStatus(); } catch (e) { toast((e as Error).message, 'error'); }
            }}><PlayCircle className="w-4 h-4" />Resume background jobs</Button>
          </div>
        </Card>
      )}

      {op && op.state === 'running' && !restoring && (
        <Card>
          <div className="space-y-2" aria-live="polite">
            <p className="text-sm font-semibold text-slate-800">{op.kind === 'backup' ? 'Creating backup' : op.kind === 'validate' ? 'Validating archive' : 'Restoring'} — {op.phase}{op.done && op.total ? ` (${op.done}/${op.total})` : ''}</p>
            <ProgressBar done={op.done} total={op.total} />
            <p className="text-[11px] text-slate-500">You can keep using the application; writes pause for at most a few seconds while the snapshot is taken.</p>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Create a full backup" subtitle="Database (one consistent snapshot) and every uploaded attachment, in one downloadable archive.">
          <div className="space-y-3 text-xs text-slate-600">
            <ul className="list-disc ml-5 space-y-0.5">
              <li>Includes all projects, budgets, contracts, payments and slips, materials, timeline, visits, contacts, users and project access, and the audit history.</li>
              <li>Not included: sign-in sessions, device push registrations, and server secrets (.env, database password, VAPID keys).</li>
              <li>The archive is checked file by file after it is written; it is only shown as <b>Verified</b> when complete.</li>
            </ul>
            <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-2 text-amber-900"><Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>The archive is <b>not encrypted</b>. It contains financial and user data (including password hashes): store it somewhere protected and share it only with administrators.</span></p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={createBackup} disabled={running || !!status.storage.problem}><DatabaseBackup className="w-4 h-4" />Create full backup</Button>
              <span className="text-[11px] text-slate-500">Free space: {bytes(status.storage.freeBytes)} · keeps the newest {status.limits.retention}</span>
            </div>
          </div>
        </Card>

        <Card title="Restore from a backup file" subtitle="Upload an archive to check it. Nothing is changed until you review it and confirm the restore.">
          <div className="space-y-3 text-xs text-slate-600">
            <input ref={fileRef} type="file" accept=".tar,application/x-tar" className="hidden" onChange={onFile} />
            <Button onClick={() => fileRef.current?.click()} disabled={running || !!upload || !!status.storage.problem}><Upload className="w-4 h-4" />Upload backup for validation</Button>
            {upload && (
              <div className="space-y-1.5" aria-live="polite">
                <p className="font-semibold text-slate-700">{upload.name}: {bytes(upload.sent)} of {bytes(upload.size)}</p>
                <ProgressBar done={upload.sent} total={upload.size} />
                {upload.error && <Notice tone="rose">{upload.error} <button type="button" className="underline font-semibold ml-1" onClick={() => setUpload(null)}>Dismiss</button></Notice>}
              </div>
            )}
            <p>Maximum size {bytes(status.limits.maxUploadBytes)}. Large files are sent in parts and resume after a dropped connection.</p>
            <p>A restore replaces <b>all</b> data in this installation. A safety backup of the current data is made first.</p>
          </div>
        </Card>
      </div>

      <Card title="Backup history" subtitle={`Application ${status.app.version}${status.app.commit ? ` (${status.app.commit})` : ''} · database version ${status.app.schema ?? '—'}`}>
        {list.backups.length === 0 ? <EmptyState title="No backups yet">Create the first full backup, then download it and keep a copy off this server.</EmptyState> : !wide ? (
          <ul className="divide-y divide-slate-100 -mx-1">
            {list.backups.map((m) => (
              <li key={m.id} className="px-1 py-2.5 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900">{formatDateTime(m.backupCreatedAt ?? m.createdAt)}</div>
                    <div className="text-[11px] text-slate-500">{BACKUP_KIND_LABELS[m.kind] ?? m.kind} · {bytes(m.size)} · {m.appVersion ?? '—'}{m.commit ? ` (${m.commit})` : ''}</div>
                    <div className="text-[11px] text-slate-500 break-all">{m.createdBy?.email ?? '—'}</div>
                  </div>
                  <StatusBadge m={m} />
                </div>
                {m.error && <div className="text-[11px] text-rose-700">{m.error}</div>}
                {m.status === 'incomplete' && <div className="text-[11px] text-amber-800">{m.attachments?.missing ?? 0} file(s) missing</div>}
                <div className="flex justify-end">{actions(m)}</div>
              </li>
            ))}
          </ul>
        ) : (
          <Table>
            <thead><tr><Th>Date</Th><Th>Type</Th><Th>Created by</Th><Th>Version</Th><Th className="text-right">Size</Th><Th>Result</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {list.backups.map((m) => (
                <tr key={m.id}>
                  <Td className="whitespace-nowrap">{formatDateTime(m.backupCreatedAt ?? m.createdAt)}{m.kind === 'uploaded' && <div className="text-[10px] text-slate-500">uploaded {formatDateTime(m.createdAt)}</div>}{m.restoredAt && <div className="text-[10px] text-emerald-700">restored {formatDateTime(m.restoredAt)}</div>}</Td>
                  <Td>{BACKUP_KIND_LABELS[m.kind] ?? m.kind}</Td>
                  <Td className="break-all">{m.createdBy?.email ?? '—'}</Td>
                  <Td className="text-[11px]">{m.appVersion ?? '—'}{m.commit ? ` · ${m.commit}` : ''}<div className="font-mono text-[10px] text-slate-500">{m.schemaVersion ?? ''}</div></Td>
                  <Td className="text-right whitespace-nowrap">{bytes(m.size)}</Td>
                  <Td><StatusBadge m={m} />{m.error && <div className="text-[10px] text-rose-700 max-w-[16rem]">{m.error}</div>}{m.status === 'incomplete' && <div className="text-[10px] text-amber-800">{m.attachments?.missing ?? 0} file(s) missing</div>}</Td>
                  <Td className="whitespace-nowrap text-right">{actions(m)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="mt-3 text-[11px] text-slate-500">Archives are stored privately on the server (BACKUP_DIR, outside the uploads folder) and downloaded only by administrators. Copy important backups off the server.</p>
      </Card>

      <Modal open={!!reviewed} wide onClose={() => setReview(null)} title="Backup details" subtitle={reviewed?.fileName}>
        {reviewed && <Review m={reviewed} status={status} running={running} onRestore={startRestore} />}
      </Modal>

      <Modal open={!!restoring} onClose={() => { if (restoring?.finished) { if (restoring.finished === 'signed-out') window.location.reload(); else setRestoring(null); } }} title="Restoring from backup">
        {restoring && (
          <div className="space-y-3 text-sm" aria-live="polite">
            {!restoring.finished && (
              <>
                <p className="font-semibold text-slate-800">{restoring.phase}{restoring.done && restoring.total ? ` (${restoring.done}/${restoring.total})` : ''}</p>
                <ProgressBar done={restoring.done} total={restoring.total} />
                <p className="text-xs text-slate-600">The application is in maintenance mode. Keep this page open. The current data stays in place until the restored copy has passed every check.</p>
              </>
            )}
            {restoring.finished === 'signed-out' && (
              <>
                <p className="flex items-center gap-2 font-semibold text-emerald-800"><CheckCircle2 className="w-5 h-5" />Restore completed</p>
                <p className="text-xs text-slate-600">All sessions were ended. Sign in with an account <b>from the restored backup</b>. Background jobs and notifications stay paused until you complete the recovery checks on this page.</p>
                <Button variant="primary" onClick={() => window.location.reload()}>Go to sign-in</Button>
              </>
            )}
            {restoring.finished === 'failed' && (
              <>
                <p className="flex items-center gap-2 font-semibold text-rose-800"><XCircle className="w-5 h-5" />Restore failed — nothing was replaced</p>
                <p className="text-xs text-slate-700">{restoring.error}</p>
                <p className="text-xs text-slate-600">The existing data and files were kept. Fix the problem described above and try again, or use the command-line recovery in docs/BACKUP_RESTORE.md.</p>
                <Button onClick={() => setRestoring(null)}>Close</Button>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function Review({ m, status, running, onRestore }: { m: BackupMeta; status: Status; running: boolean; onRestore: (m: BackupMeta, password: string, confirmation: string) => Promise<void> }) {
  const v = m.validation;
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const phrase = `RESTORE ${m.id.slice(0, 8)}`;
  if (!v) return <Notice tone="amber">This archive has not been validated yet. Use “Validate again”.</Notice>;
  const restorable = v.ok && v.compatibility.compatible && RESTORABLE.includes(m.status);
  const mf = v.manifest;
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {v.ok ? <Badge tone="emerald"><CheckCircle2 className="w-3 h-3" />Archive valid</Badge> : <Badge tone="rose"><XCircle className="w-3 h-3" />Rejected</Badge>}
        <Badge tone={v.compatibility.compatible ? 'emerald' : 'rose'}>{v.compatibility.compatible ? 'Compatible' : 'Not compatible'}</Badge>
        {mf && (mf.complete ? <Badge tone="emerald">Complete</Badge> : <Badge tone="amber"><AlertTriangle className="w-3 h-3" />Incomplete</Badge>)}
        <Badge tone="slate">Not encrypted</Badge>
      </div>
      {mf && (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          <div><dt className="text-slate-500">Backup date</dt><dd className="font-semibold">{formatDateTime(mf.createdAt)}</dd></div>
          <div><dt className="text-slate-500">Created by</dt><dd>{mf.createdBy?.email ?? '—'} ({mf.source === 'pre_restore' ? 'safety backup' : mf.source})</dd></div>
          <div><dt className="text-slate-500">Application version</dt><dd>{mf.app.version}{mf.app.commit ? ` · ${mf.app.commit}` : ''}</dd></div>
          <div><dt className="text-slate-500">Database version</dt><dd className="font-mono text-[11px]">{mf.schemaLatest}</dd></div>
          <div><dt className="text-slate-500">Archive</dt><dd>{bytes(v.archiveBytes)} · format {mf.formatVersion} · PostgreSQL {mf.postgres}</dd></div>
          <div><dt className="text-slate-500">Checked</dt><dd>{formatDateTime(v.checkedAt)}</dd></div>
        </dl>
      )}
      <p className={`text-xs rounded-lg px-3 py-2 border ${v.compatibility.compatible ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-rose-50 border-rose-200 text-rose-900'}`}>{v.compatibility.message}</p>

      <section>
        <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-1">Contents</h4>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs">
          {Object.entries(BACKUP_COUNT_LABELS).filter(([k]) => v.counts[k] !== undefined).map(([k, label]) => (
            <div key={k} className="flex justify-between gap-2 border-b border-slate-100 py-0.5"><span className="text-slate-600">{label}</span><span className="font-mono font-semibold">{v.counts[k]}</span></div>
          ))}
          <div className="flex justify-between gap-2 border-b border-slate-100 py-0.5"><span className="text-slate-600">Uploaded files</span><span className="font-mono font-semibold">{v.attachments.filesIncluded} · {bytes(v.attachments.bytes)}</span></div>
        </div>
        {v.projects.length > 0 && <p className="mt-2 text-[11px] text-slate-600">Projects: {v.projects.map((p) => `${p.code} ${p.name}${p.archived ? ' (archived)' : ''}`).join(' · ')}</p>}
      </section>

      {v.errors.length > 0 && <Notice tone="rose" title="Validation failed — this archive cannot be restored"><ul className="list-disc ml-4">{v.errors.slice(0, 10).map((e) => <li key={e}>{e}</li>)}</ul></Notice>}
      {v.warnings.length > 0 && <Notice tone="amber" title="Warnings"><ul className="list-disc ml-4">{v.warnings.slice(0, 10).map((w) => <li key={w}>{w}</li>)}</ul>{v.warnings.length > 10 && <p>…and {v.warnings.length - 10} more.</p>}</Notice>}

      {restorable && (
        <section className="rounded-xl border border-rose-200 bg-rose-50/50 p-3 space-y-3">
          <h4 className="flex items-center gap-1.5 text-sm font-bold text-rose-900"><ShieldAlert className="w-4 h-4" />What a restore replaces</h4>
          <ul className="list-disc ml-5 text-xs text-rose-950 space-y-0.5">
            <li><b>All data in this installation</b>{status.current ? ` — currently ${status.current.projects} projects, ${status.current.users} users, ${status.current.payment_transactions} payment transfers and ${status.current.attachments} attachment records` : ''} — is replaced by the backup. Nothing is merged.</li>
            <li>Everyone is signed out, including you. Sign in afterwards with an account from the backup.</li>
            <li>Uploaded files from the backup are added; existing files are never overwritten or deleted.</li>
            <li>A safety backup of the current data is created and verified first; the restore stops if it fails.</li>
            <li>Device push registrations are cleared; background jobs stay paused until you resume them. No notification or payment is sent.</li>
            {!mf?.complete && <li className="font-semibold">This backup is incomplete: {v.attachments.missing} attachment file(s) will be missing after the restore.</li>}
          </ul>
          <form className="grid gap-2 sm:grid-cols-2" onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            setBusy(true);
            try { await onRestore(m, password, typed); } catch (ex) { setErr(ex instanceof ApiError ? ex.message : (ex as Error).message); } finally { setBusy(false); }
          }}>
            <label className="text-xs font-semibold text-slate-700">Your password (re-check)
              <input type="password" autoComplete="current-password" className={`${inputCls} mt-1`} value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <label className="text-xs font-semibold text-slate-700">Type <span className="font-mono text-rose-800">{phrase}</span> to confirm
              <input className={`${inputCls} mt-1 font-mono`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} required />
            </label>
            {err && <div className="sm:col-span-2"><Notice tone="rose">{err}</Notice></div>}
            <div className="sm:col-span-2 flex justify-end">
              <Button type="submit" variant="danger" busy={busy} disabled={running || typed.trim() !== phrase || !password}>Replace all data with this backup</Button>
            </div>
          </form>
        </section>
      )}
      {!restorable && v.ok && !RESTORABLE.includes(m.status) && <Notice tone="sky">Validate this archive again before restoring it.</Notice>}
    </div>
  );
}
