import React from 'react';
import { Mail, MessageCircle, Phone } from 'lucide-react';
import { formatPhone, telUrl, whatsappUrl } from '../../../shared/directory';

/** Call / email / WhatsApp links where details exist. WhatsApp only opens a chat; nothing is sent. */
export function ContactActions({ phone, email, whatsapp = true, compact = false, name }: { phone?: string | null; email?: string | null; whatsapp?: boolean; compact?: boolean; name?: string }) {
  const tel = telUrl(phone);
  const wa = whatsapp ? whatsappUrl(phone) : '';
  const cls = `inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white text-sky-700 hover:bg-sky-50 no-underline ${compact ? 'min-h-8 px-2 text-[11px]' : 'min-h-9 px-2.5 text-xs'} font-semibold`;
  const who = name ? ` ${name}` : '';
  if (!tel && !email) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {tel && <a href={tel} className={cls} aria-label={`Call${who} ${formatPhone(phone)}`} title={`Call ${formatPhone(phone)}`}><Phone className="w-3.5 h-3.5" />{!compact && 'Call'}</a>}
      {wa && <a href={wa} target="_blank" rel="noopener noreferrer" className={cls} aria-label={`Open WhatsApp chat with${who || ' this number'} (nothing is sent automatically)`} title="Open WhatsApp (nothing is sent automatically)"><MessageCircle className="w-3.5 h-3.5 text-emerald-600" />{!compact && 'WhatsApp'}</a>}
      {email && <a href={`mailto:${email}`} className={cls} aria-label={`Email${who} ${email}`} title={`Email ${email}`}><Mail className="w-3.5 h-3.5" />{!compact && 'Email'}</a>}
    </span>
  );
}
