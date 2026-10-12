// Unicode-safe handling of user-visible file names (Arabic, English and mixed names).
// Physical files are always stored under generated ids; these names are only shown and used for
// download headers, never as file-system paths or HTML.

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** Bidirectional override / isolate controls can disguise an extension (e.g. "gpj.exe"); removed. */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;
/** Characters that are unsafe in file names on common systems. */
const UNSAFE = /[<>:"/\\|?*]/g;

/**
 * Cleans a client-supplied file name: keeps every letter (Arabic included), digits, spaces and normal
 * punctuation; drops any directory part, control and bidi-override characters and path separators;
 * normalises to NFC and limits the length while keeping the extension.
 */
export function sanitizeFileName(input: string, max = 200): string {
  const base = String(input ?? '').split(/[\\/]/).pop() ?? '';
  let s = base.normalize('NFC').replace(CONTROL, '').replace(BIDI_CONTROLS, '').replace(UNSAFE, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').trim(); // no hidden / relative names
  const chars = [...s];
  if (chars.length > max) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
    s = [...s.slice(0, s.length - ext.length)].slice(0, max - [...ext].length).join('').trim() + ext;
  }
  return s || 'file';
}

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? `.${m[1].toLowerCase()}` : '';
}

/** Name used for display and downloads: the display name when set, keeping the stored file's extension. */
export function effectiveFileName(a: { original_name: string; display_name?: string | null }): string {
  const display = a.display_name?.trim();
  if (!display) return a.original_name;
  const ext = extensionOf(a.original_name);
  return ext && extensionOf(display) !== ext ? `${display}${ext}` : display;
}

/**
 * Detects a name that was stored with its UTF-8 bytes read as Latin-1 (e.g. "Ø±Ø®ØµØ©.pdf") and returns
 * the likely original. Only a suggestion: nothing is changed unless a user applies it as the display name.
 */
// Windows-1252 characters that stand for bytes 0x80–0x9F when UTF-8 was misread as cp1252 instead of Latin-1.
const CP1252: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

export function suggestRepairedName(name: string): string | null {
  if (!name || !/[À-ÿ]/.test(name)) return null;
  const bytes: number[] = [];
  for (const c of name) {
    const code = c.charCodeAt(0);
    if (code <= 0xff) bytes.push(code);
    else if (CP1252[c] !== undefined) bytes.push(CP1252[c]);
    else return null; // a real non-Latin character: the name is not a misread one
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
  if (decoded === name || ![...decoded].some((c) => c.charCodeAt(0) > 0xff)) return null;
  return sanitizeFileName(decoded);
}
