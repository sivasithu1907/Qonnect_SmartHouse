import React, { useEffect, useRef, useState } from 'react';
import { ImagePlus, Minus, Plus, Trash2 } from 'lucide-react';
import { api, upload } from '../lib/api';
import { Avatar } from './Avatar';
import { Button, Modal, Notice, useUi } from './ui';

export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const AVATAR_MAX_MB = 5;
const VIEW = 256; // crop viewport (CSS px)

/**
 * Upload, crop / reposition to a square, save, replace or remove a profile picture. The current picture stays
 * until the new one has been uploaded and saved. Used for the signed-in user and, by administrators, for others.
 */
export function ProfilePictureEditor({ userId, name, version, onChanged }: { userId: string; name: string; version: string | null | undefined; onChanged: (version: string | null) => void | Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const { toast, confirm } = useUi();

  // release the temporary preview URL
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const base = nat ? VIEW / Math.min(nat.w, nat.h) : 1;
  const scale = base * zoom;
  const clamp = (p: { x: number; y: number }, s = scale) => nat ? {
    x: Math.min(0, Math.max(VIEW - nat.w * s, p.x)),
    y: Math.min(0, Math.max(VIEW - nat.h * s, p.y)),
  } : p;

  const choose = (f: File | undefined) => {
    setErr(null);
    if (!f) return;
    if (!AVATAR_TYPES.includes(f.type)) { setErr('Choose a JPEG, PNG or WebP picture.'); return; }
    if (f.size > AVATAR_MAX_MB * 1024 * 1024) { setErr(`The picture is larger than ${AVATAR_MAX_MB} MB.`); return; }
    if (src) URL.revokeObjectURL(src);
    setFile(f); setSrc(URL.createObjectURL(f)); setNat(null); setZoom(1);
  };
  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const w = e.currentTarget.naturalWidth, h = e.currentTarget.naturalHeight; // orientation already applied by the browser
    const s = VIEW / Math.min(w, h);
    setNat({ w, h });
    setPos({ x: (VIEW - w * s) / 2, y: (VIEW - h * s) / 2 }); // centred
  };
  const onImgError = () => { setErr('This picture could not be read. Choose a JPEG, PNG or WebP file.'); setFile(null); setSrc(null); };
  const setZoomKeepCentre = (z: number) => {
    const nz = Math.min(4, Math.max(1, z));
    const c = VIEW / 2;
    const ns = base * nz;
    setPos((p) => clamp({ x: c - ((c - p.x) / scale) * ns, y: c - ((c - p.y) / scale) * ns }, ns));
    setZoom(nz);
  };
  const crop = () => {
    if (!nat) return null;
    const size = Math.round(VIEW / scale);
    const x = Math.round(Math.min(nat.w - size, Math.max(0, -pos.x / scale)));
    const y = Math.round(Math.min(nat.h - size, Math.max(0, -pos.y / scale)));
    return { x, y, size };
  };

  const save = async () => {
    const c = crop();
    if (!file || !c) return;
    setBusy(true); setErr(null);
    try {
      const r = await upload<{ avatar_version: string }>(`/api/users/${userId}/avatar`, { x: String(c.x), y: String(c.y), size: String(c.size) }, file);
      toast('Profile picture saved');
      setFile(null); setSrc(null); setNat(null);
      await onChanged(r.avatar_version);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirm('Remove the profile picture? Initials will be shown instead.', { title: 'Remove picture', confirmLabel: 'Remove', danger: true }))) return;
    setBusy(true); setErr(null);
    try { await api('DELETE', `/api/users/${userId}/avatar`); toast('Profile picture removed'); await onChanged(null); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3" data-testid="profile-picture">
      {!src ? (
        <div className="flex flex-wrap items-center gap-4">
          <Avatar userId={userId} name={name} version={version} size="xl" />
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => input.current?.click()} disabled={busy}><ImagePlus className="w-4 h-4" />{version ? 'Replace picture' : 'Upload picture'}</Button>
              {version && <Button variant="ghost" onClick={remove} busy={busy}><Trash2 className="w-4 h-4" />Remove</Button>}
            </div>
            <p className="text-[11px] text-slate-500 max-w-xs">JPEG, PNG or WebP, up to {AVATAR_MAX_MB} MB. You can position it before saving. It is resized to a small square and its photo details (such as location) are removed.</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-4">
          <div>
            <div
              className="relative overflow-hidden rounded-xl bg-slate-900 touch-none cursor-grab active:cursor-grabbing focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
              style={{ width: VIEW, height: VIEW }} tabIndex={0} role="application"
              aria-label="Position the picture: drag, or use the arrow keys. Use plus and minus to zoom."
              onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; }}
              onPointerMove={(e) => { const d = drag.current; if (d) setPos(clamp({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y })); }}
              onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 30 : 8;
                const k: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
                if (k[e.key]) { e.preventDefault(); setPos((p) => clamp({ x: p.x + k[e.key][0], y: p.y + k[e.key][1] })); }
                if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoomKeepCentre(zoom + 0.25); }
                if (e.key === '-') { e.preventDefault(); setZoomKeepCentre(zoom - 0.25); }
              }}
              onWheel={(e) => { if (nat) setZoomKeepCentre(zoom - Math.sign(e.deltaY) * 0.1); }}>
              <img src={src} alt="" onLoad={onImgLoad} onError={onImgError} draggable={false} className="absolute max-w-none select-none pointer-events-none"
                style={nat ? { left: pos.x, top: pos.y, width: nat.w * scale, height: nat.h * scale } : { opacity: 0 }} />
              {/* circular guide: everything outside the circle is dimmed */}
              <div aria-hidden="true" className="absolute inset-0 rounded-full pointer-events-none" style={{ boxShadow: '0 0 0 9999px rgba(15,23,42,0.55)' }} />
              <div aria-hidden="true" className="absolute inset-0 rounded-full ring-2 ring-white/80 pointer-events-none" />
            </div>
            <div className="mt-2 flex items-center gap-2" style={{ width: VIEW }}>
              <button type="button" className="p-1.5 rounded-lg hover:bg-slate-100" onClick={() => setZoomKeepCentre(zoom - 0.25)} aria-label="Zoom out"><Minus className="w-4 h-4" /></button>
              <input type="range" min={1} max={4} step={0.05} value={zoom} onChange={(e) => setZoomKeepCentre(Number(e.target.value))} className="flex-1 accent-sky-600" aria-label="Zoom" />
              <button type="button" className="p-1.5 rounded-lg hover:bg-slate-100" onClick={() => setZoomKeepCentre(zoom + 0.25)} aria-label="Zoom in"><Plus className="w-4 h-4" /></button>
            </div>
          </div>
          <div className="space-y-2 min-w-[10rem]">
            <p className="text-xs text-slate-600">Drag to reposition and zoom to fit. The circle shows how it will appear.</p>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-500">Current:</span><Avatar userId={userId} name={name} version={version} size="lg" />
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="primary" onClick={save} busy={busy} disabled={!nat || busy}>Save picture</Button>
              <Button onClick={() => { setFile(null); setSrc(null); setNat(null); setErr(null); }} disabled={busy}>Cancel</Button>
            </div>
            <p className="text-[11px] text-slate-500">The current picture stays until the new one is saved.</p>
          </div>
        </div>
      )}
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
      {err && <Notice tone="rose">{err}</Notice>}
    </div>
  );
}

/** "Profile picture" dialog for the signed-in user (account menu). */
export function ProfilePictureModal({ open, onClose, userId, name, version, onChanged }: { open: boolean; onClose: () => void; userId: string; name: string; version: string | null | undefined; onChanged: (v: string | null) => void | Promise<void> }) {
  return (
    <Modal open={open} onClose={onClose} title="Profile picture" subtitle="Shown in the top bar, user lists, assignees and comments.">
      {open && <ProfilePictureEditor userId={userId} name={name} version={version} onChanged={onChanged} />}
    </Modal>
  );
}
