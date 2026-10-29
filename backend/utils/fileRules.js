const path = require('path');

// Rules for uploaded files (Group 5). The browser checks the same (frontend/src/fileRules.js),
// only for convenience: these are the real checks.

const MB = 1024 * 1024;

// Highest size per kind of upload. "highlighted" = the file the highlighter saved (only the kept
// pages of a PDF, or a capped image); "unchanged" = a file uploaded as it is (grading document,
// "add missing info" without highlights).
const MAX_BYTES = { highlighted: 15 * MB, unchanged: 10 * MB };
const MAX_UPLOAD_BYTES = Math.max(...Object.values(MAX_BYTES));

// The real type comes from the file's first bytes; the name and the browser's claim are not trusted
const TYPES = [
    { ext: 'pdf', mime: 'application/pdf', extensions: ['.pdf'], matches: (b) => b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-' },
    { ext: 'jpg', mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'], matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { ext: 'png', mime: 'image/png', extensions: ['.png'], matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
];

/**
 * The file's real type, if it is an allowed one AND its name has a matching extension
 * (a text file renamed to .pdf, or a PNG named .pdf, is refused).
 * @returns {{ ext, mime } | null}
 */
const detectFileType = (buffer, originalName) => {
    const type = TYPES.find((t) => t.matches(buffer));
    if (!type) return null;
    const extension = path.extname(String(originalName || '')).toLowerCase();
    return type.extensions.includes(extension) ? { ext: type.ext, mime: type.mime } : null;
};

const maxBytesFor = (kind) => (kind === 'highlighted' ? MAX_BYTES.highlighted : MAX_BYTES.unchanged);
const megabytes = (bytes) => Math.round(bytes / MB);

// The original name, cleaned for display: no folders, no control characters, at most 120 characters
const cleanOriginalName = (name) => path.basename(String(name || 'file')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) || 'file';

// Stored in the file's metadata, which only takes plain ASCII: so it is percent-encoded
const encodeForMetadata = (name) => encodeURIComponent(name);
const decodeFromMetadata = (value) => {
    try { return value ? decodeURIComponent(value) : null; } catch { return null; }
};

/**
 * Content-Disposition with the original name, so a download keeps it, accents included:
 * a plain-ASCII fallback for old programs plus the UTF-8 name (RFC 6266 / RFC 5987).
 */
const contentDisposition = (name) => {
    const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

module.exports = {
    MB, MAX_BYTES, MAX_UPLOAD_BYTES, detectFileType, maxBytesFor, megabytes,
    cleanOriginalName, encodeForMetadata, decodeFromMetadata, contentDisposition,
};
