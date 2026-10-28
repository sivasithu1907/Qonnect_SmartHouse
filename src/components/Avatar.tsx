import React, { useEffect, useState } from 'react';

/** Up to two initials from a name (works for Arabic and Latin names). */
export function initialsOf(name: string | null | undefined): string {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = [...parts[0]][0] ?? '';
  const last = parts.length > 1 ? [...parts[parts.length - 1]][0] ?? '' : '';
  return (first + last).toUpperCase();
}

const SIZES = { xs: 'w-5 h-5 text-[9px]', sm: 'w-7 h-7 text-[11px]', md: 'w-8 h-8 text-xs', lg: 'w-12 h-12 text-sm', xl: 'w-24 h-24 text-2xl' } as const;

/**
 * Circular profile picture with initials as the fallback (no picture, or the picture cannot be loaded).
 * The image comes from the authorised avatar URL; `version` changes whenever the picture changes, so a new
 * picture shows immediately without signing out.
 */
export function Avatar({ userId, name, version, size = 'md', className = '' }: {
  userId?: string | null; name?: string | null; version?: string | null; size?: keyof typeof SIZES; className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [userId, version]);
  const showImg = !!userId && !!version && !failed;
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center rounded-full overflow-hidden bg-slate-100 border border-slate-200 font-bold text-slate-700 select-none ${SIZES[size]} ${className}`}
      aria-hidden="true">
      {showImg
        ? <img src={`/api/users/${userId}/avatar?v=${encodeURIComponent(version!)}`} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" onError={() => setFailed(true)} draggable={false} />
        : <span>{initialsOf(name)}</span>}
    </span>
  );
}

/** Avatar followed by the person's name (assignees, comment authors). */
export function AvatarName({ userId, name, version, size = 'xs', className = '' }: { userId?: string | null; name: string; version?: string | null; size?: keyof typeof SIZES; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 min-w-0 align-middle ${className}`}>
      <Avatar userId={userId} name={name} version={version} size={size} />
      <span className="truncate">{name}</span>
    </span>
  );
}
