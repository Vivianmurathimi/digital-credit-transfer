// File rules in the browser (Group 5): the same types and limits as the server
// (backend/utils/fileRules.js). Only for convenience; the server checks everything again.

const MB = 1024 * 1024;

// Highest sizes in MB:
//  - a file opened in the highlighter (only the saved pages are uploaded)
//  - what the highlighter saves (server limit for "highlighted" uploads)
//  - a file uploaded unchanged (grading document, "add missing info" without highlights)
export const MAX_MB = { highlighterOriginal: 50, highlighted: 15, unchanged: 10 };

export const ACCEPT = '.pdf,.jpg,.jpeg,.png';

// The real type from the file's first bytes, like the server: a renamed text file isn't a PDF
const SIGNATURES = [
    { extensions: ['.pdf'], matches: (b) => b.length >= 5 && String.fromCharCode(...b.slice(0, 5)) === '%PDF-' },
    { extensions: ['.jpg', '.jpeg'], matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { extensions: ['.png'], matches: (b) => b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v) },
];
const extensionOf = (name) => (/\.[^.]+$/.exec(String(name || '').toLowerCase()) || [''])[0];

/**
 * Checks a chosen file: allowed type (by content AND name) and size.
 * @returns {Promise<null | { code: 'FILE_TYPE_NOT_ALLOWED' } | { code: 'FILE_TOO_LARGE', params: { max } }>}
 *          null = fine; otherwise an error to translate with t(`errors.${code}`, params)
 */
export const checkFile = async (file, maxMb) => {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const type = SIGNATURES.find((s) => s.matches(head));
    if (!type || !type.extensions.includes(extensionOf(file.name))) return { code: 'FILE_TYPE_NOT_ALLOWED' };
    if (file.size > maxMb * MB) return { code: 'FILE_TOO_LARGE', params: { max: maxMb } };
    return null;
};

// Size check for a file the highlighter produced
export const tooLargeToUpload = (blob, maxMb) => (blob.size > maxMb * MB ? { code: 'FILE_TOO_LARGE', params: { max: maxMb } } : null);

/**
 * The file name from a Content-Disposition header (the UTF-8 name if present, else the plain one).
 * Returns null without a usable name.
 */
export const fileNameFromDisposition = (header) => {
    if (!header) return null;
    const utf8 = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
    if (utf8) {
        try { return decodeURIComponent(utf8[1].trim()); } catch { /* fall back to the plain name */ }
    }
    const plain = /filename\s*=\s*"([^"]*)"/i.exec(header);
    return plain ? plain[1] : null;
};
