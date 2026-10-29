// Plain logic of the evidence highlighter (no React), so it can be tested in Node.
// The component (components/EvidenceHighlighter.js) renders pages and records marks;
// this file decides which pages are kept and builds the saved file.
import { PDFDocument, StandardFonts, BlendMode, rgb } from 'pdf-lib';
import { MAX_PAGES } from './evidenceLimits';

export { MAX_PAGES };

// How the yellow marks look: drawn opaque on their own layer, then shown and saved
// see-through with "multiply", so text stays readable and overlaps don't get darker
export const MARK_OPACITY = 0.4;
export const MARK_COLOR = '#ffe600';

// Images keep their resolution, but the longer side is capped (a phone photo would be huge)
export const MAX_IMAGE_SIDE = 2500;

// Height of the strip added below each saved PDF page for "Original page X of Y" (in PDF points)
const STRIP_HEIGHT = 18;

/**
 * Pages kept in the saved PDF: always page 1 (it usually names the course and institution),
 * plus every page with marks, in original order, each once. Page numbers start at 1.
 */
export const pagesToKeep = (markedPages) => [...new Set([1, ...markedPages])].sort((a, b) => a - b);

/**
 * Whether a mark layer still has visible marks: any pixel that isn't (almost) transparent.
 * Works on the layer's pixels, so drawing and then erasing everything counts as no marks.
 * @param data the RGBA bytes of the layer (ImageData.data)
 */
export const hasVisibleMarks = (data, alphaThreshold = 16) => {
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] > alphaThreshold) return true;
    }
    return false;
};

// Whether a PDF has more pages than allowed (it is refused when opened, never cut)
export const isTooLong = (pageCount, maxPages) => pageCount > maxPages;

// Rendered page images take a lot of memory, so only the most recently viewed few are kept.
// Returns the new order (most recent last) and the pages whose rendering can be dropped.
export const RENDERED_PAGES_KEPT = 3;
export const rememberRecent = (recent, number, keep = RENDERED_PAGES_KEPT) => {
    const list = [...recent.filter((n) => n !== number), number];
    return { recent: list.slice(-keep), evicted: list.slice(0, Math.max(0, list.length - keep)) };
};

// Width and height scaled so the longer side is at most `max` (never enlarged)
export const fitWithin = (width, height, max = MAX_IMAGE_SIDE) => {
    const factor = Math.min(1, max / Math.max(width, height));
    return { width: Math.round(width * factor), height: Math.round(height * factor) };
};

// Adds the strip below a page (enlarging the page, so nothing on it is covered) and writes the label
const addPageStrip = (page, font, label, box) => {
    page.setMediaBox(box.x, box.y - STRIP_HEIGHT, box.width, box.height + STRIP_HEIGHT);
    page.setCropBox(box.x, box.y - STRIP_HEIGHT, box.width, box.height + STRIP_HEIGHT);
    page.drawRectangle({ x: box.x, y: box.y - STRIP_HEIGHT, width: box.width, height: STRIP_HEIGHT, color: rgb(1, 1, 1) });
    page.drawText(label, { x: box.x + 8, y: box.y - STRIP_HEIGHT + 5, size: 8, font, color: rgb(0.35, 0.35, 0.35) });
};

const stripLabel = (number, total) => `Original page ${number} of ${total}`;

// pdf-lib reads bytes from the start of their memory buffer, so hand it a byte array that owns
// its whole buffer (a slice of a larger buffer, e.g. a Node Buffer, would be read wrongly)
const ownBytes = (bytes) => (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : new Uint8Array(bytes));

/**
 * Builds the saved PDF: the kept pages with their marks, and "Original page X of Y" below each.
 *
 * First choice: the original pages are copied unchanged (text stays sharp and searchable)
 * and the mark layer is drawn over them. If the PDF can't be copied (protected/encrypted,
 * or a rotated page), the pages are rebuilt from their rendered images instead, so the
 * student is never blocked at save.
 *
 * @param originalBytes the uploaded PDF (Uint8Array)
 * @param keep          page numbers to keep (see pagesToKeep)
 * @param totalPages    number of pages in the original
 * @param pageSize(n)       -> { width, height } of page n in PDF points (unrotated, as displayed)
 * @param overlayPng(n)     -> Promise<Uint8Array|null> transparent PNG of page n's marks, or null
 * @param flattenedJpeg(n)  -> Promise<Uint8Array> page n rendered with its marks (for the fallback)
 * @returns {Promise<{ bytes: Uint8Array, mode: 'copied' | 'images' }>}
 */
export const buildHighlightedPdf = async ({ originalBytes, keep, totalPages, pageSize, overlayPng, flattenedJpeg }) => {
    try {
        const source = await PDFDocument.load(ownBytes(originalBytes));
        const indices = keep.map((n) => n - 1);
        if (indices.some((i) => source.getPage(i).getRotation().angle % 360 !== 0)) throw new Error('rotated page');

        const out = await PDFDocument.create();
        const font = await out.embedFont(StandardFonts.Helvetica);
        const pages = await out.copyPages(source, indices);
        for (let k = 0; k < pages.length; k += 1) {
            const page = out.addPage(pages[k]);
            const box = page.getCropBox();
            const overlay = await overlayPng(keep[k]);
            if (overlay) {
                const image = await out.embedPng(ownBytes(overlay));
                page.drawImage(image, { x: box.x, y: box.y, width: box.width, height: box.height, opacity: MARK_OPACITY, blendMode: BlendMode.Multiply });
            }
            addPageStrip(page, font, stripLabel(keep[k], totalPages), box);
        }
        return { bytes: await out.save(), mode: 'copied' };
    } catch (err) {
        // Protected or unusual PDF: build it from the rendered page images instead
        const out = await PDFDocument.create();
        const font = await out.embedFont(StandardFonts.Helvetica);
        for (const n of keep) {
            const { width, height } = pageSize(n);
            const page = out.addPage([width, height]);
            const image = await out.embedJpg(ownBytes(await flattenedJpeg(n)));
            page.drawImage(image, { x: 0, y: 0, width, height });
            addPageStrip(page, font, stripLabel(n, totalPages), { x: 0, y: 0, width, height });
        }
        return { bytes: await out.save(), mode: 'images' };
    }
};
