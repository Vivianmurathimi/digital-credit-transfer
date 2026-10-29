import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as pdfjsLib from 'pdfjs-dist';
import {
    MARK_COLOR, MARK_OPACITY, MAX_PAGES, fitWithin, hasVisibleMarks, isTooLong, pagesToKeep, rememberRecent, buildHighlightedPdf,
} from '../highlighter';

// The PDF engine's helper (worker) is bundled with the app, so its version always matches
// the installed pdfjs-dist (it used to come from a CDN under a file name that no longer exists)
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

const RENDER_SCALE = 2;          // pages are rendered at about 2x, so marks and saved pages are sharp
const MAX_RENDER_WIDTH = 2400;   // ...but very large pages are rendered smaller than that
const MARKER_WIDTH = 18;         // in page pixels, so it looks the same on any screen size
const ERASER_WIDTH = 40;

const newCanvas = (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
};

const copyCanvas = (source) => {
    const canvas = newCanvas(source.width, source.height);
    canvas.getContext('2d').drawImage(source, 0, 0);
    return canvas;
};

// A canvas as file bytes
const canvasBytes = (canvas, type, quality) => new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject) : reject(new Error('empty canvas'))), type, quality);
});

const canvasHasMarks = (canvas) => hasVisibleMarks(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);

// The page with its marks merged in, the way they look on screen (see-through, multiply)
const flatten = (pageCanvas, marksCanvas) => {
    const canvas = newCanvas(pageCanvas.width, pageCanvas.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(pageCanvas, 0, 0);
    if (marksCanvas) {
        ctx.globalAlpha = MARK_OPACITY;
        ctx.globalCompositeOperation = 'multiply';
        ctx.drawImage(marksCanvas, 0, 0);
    }
    return canvas;
};

// "transcript.pdf" -> "transcript (highlighted).pdf", so the student recognises the saved file
const highlightedName = (original, extension) => {
    const base = String(original || 'document').replace(/\.[^.]+$/, '').slice(0, 100) || 'document';
    return `${base} (highlighted).${extension}`;
};

const smallButton = { padding: '5px 10px', border: '1px solid var(--control-border)', borderRadius: '4px', cursor: 'pointer', backgroundColor: 'var(--surface)' };

/**
 * Highlighter for one evidence file (PDF, or a photo/scan as JPG/PNG).
 * Used by the application form and the "add missing info" window.
 *
 * Pages are rendered only when viewed, and only the last few renderings are kept in memory;
 * marks are kept for every page that has them. Marks are stored in page pixels (not screen
 * pixels), so they stay aligned when the window is resized and the saved file is sharp.
 * Saving hands the finished file to onSave(blob, fileName); uploading is up to the caller.
 *
 * @param kind 'transcript' or 'syllabus': sets the page limit (longer PDFs are refused when opened)
 */
const EvidenceHighlighter = ({ file, onSave, onCancel, kind = 'syllabus' }) => {
    const { t } = useTranslation();
    const maxPages = MAX_PAGES[kind];
    const [status, setStatus] = useState('loading'); // loading | ready | saving | error
    const [message, setMessage] = useState('');
    const [tool, setTool] = useState('marker');
    const [pageNumber, setPageNumber] = useState(1);
    const [pageCount, setPageCount] = useState(1);
    const [pageLoading, setPageLoading] = useState(false);
    const [markedPages, setMarkedPages] = useState([]); // pages with visible marks, for "pages that will be saved"

    const pageCanvasRef = useRef(null);   // on screen: the current page
    const markCanvasRef = useRef(null);   // on screen: the current page's marks (drawn on)
    const docRef = useRef(null);          // pdf.js document (PDFs only)
    const bytesRef = useRef(null);        // the original PDF
    // page number -> { page: rendered canvas or null (dropped to save memory), marks: canvas or null, points: { width, height } }
    const pagesRef = useRef(new Map());
    const recentRef = useRef([]);         // recently viewed pages, most recent last
    const shownRef = useRef(null);        // page number currently on screen
    const requestRef = useRef(0);         // newest page request, so a slow render can't show an old page
    const strokeRef = useRef(null);       // { pointerId, last: { x, y } } while drawing
    const isPdf = file.type === 'application/pdf';

    const updateMarked = useCallback(() => {
        const marked = [...pagesRef.current.entries()].filter(([, e]) => e.marks).map(([n]) => n);
        setMarkedPages(marked.sort((a, b) => a - b));
    }, []);

    // Copies the on-screen marks back into their page's own layer (only kept if something is left)
    const keepShownMarks = useCallback(() => {
        const entry = pagesRef.current.get(shownRef.current);
        if (!entry || !markCanvasRef.current) return;
        entry.marks = canvasHasMarks(markCanvasRef.current) ? copyCanvas(markCanvasRef.current) : null;
    }, []);

    // Renders a page (again, if its rendering was dropped) and remembers it
    const renderPage = useCallback(async (number) => {
        const existing = pagesRef.current.get(number);
        if (existing && existing.page) return existing;
        const page = await docRef.current.getPage(number);
        const points = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(RENDER_SCALE, MAX_RENDER_WIDTH / points.width) });
        const canvas = newCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const entry = existing || { marks: null, points: { width: points.width, height: points.height } };
        entry.page = canvas;
        pagesRef.current.set(number, entry);
        return entry;
    }, []);

    // Keeps only the last few renderings (the shown page is always among them)
    const noteViewed = useCallback((number) => {
        const { recent, evicted } = rememberRecent(recentRef.current, number);
        recentRef.current = recent;
        evicted.forEach((n) => { const e = pagesRef.current.get(n); if (e && n !== shownRef.current) e.page = null; });
    }, []);

    // Puts a page and its marks on screen
    const showPage = useCallback(async (number) => {
        const request = ++requestRef.current;
        strokeRef.current = null; // a page change ends any stroke
        keepShownMarks();
        updateMarked();
        setPageLoading(true);
        try {
            const entry = isPdf ? await renderPage(number) : pagesRef.current.get(1);
            if (request !== requestRef.current) return; // a newer page was requested meanwhile
            const pageCanvas = pageCanvasRef.current;
            const markCanvas = markCanvasRef.current;
            if (!pageCanvas || !markCanvas) return;
            pageCanvas.width = markCanvas.width = entry.page.width;
            pageCanvas.height = markCanvas.height = entry.page.height;
            pageCanvas.getContext('2d').drawImage(entry.page, 0, 0);
            if (entry.marks) markCanvas.getContext('2d').drawImage(entry.marks, 0, 0);
            shownRef.current = number;
            setPageNumber(number);
            if (isPdf) {
                noteViewed(number);
                // Render the next page in the background, so "Next" usually feels instant
                const next = number + 1;
                if (next <= docRef.current.numPages && !pagesRef.current.get(next)?.page) {
                    renderPage(next).then(() => noteViewed(next)).then(() => noteViewed(number)).catch(() => {});
                }
            }
        } finally {
            if (request === requestRef.current) setPageLoading(false);
        }
    }, [isPdf, keepShownMarks, noteViewed, renderPage, updateMarked]);

    // Open the file
    useEffect(() => {
        let cancelled = false;
        pagesRef.current = new Map();
        recentRef.current = [];
        shownRef.current = null;
        setStatus('loading');
        setMessage('');
        setMarkedPages([]);

        const open = async () => {
            if (isPdf) {
                const bytes = new Uint8Array(await file.arrayBuffer());
                bytesRef.current = bytes;
                // pdf.js takes over the bytes it is given, so it gets its own copy
                const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
                if (cancelled) { doc.destroy(); return; }
                // Too long: refused before any page is rendered (never cut to the first pages)
                if (isTooLong(doc.numPages, maxPages)) {
                    doc.destroy();
                    setStatus('error');
                    setMessage(t(kind === 'transcript' ? 'student_highlighter_too_many_pages_transcript' : 'student_highlighter_too_many_pages', { pages: doc.numPages, max: maxPages }));
                    return;
                }
                docRef.current = doc;
                setPageCount(doc.numPages);
            } else {
                const url = URL.createObjectURL(file);
                try {
                    const image = await new Promise((resolve, reject) => {
                        const img = new Image();
                        img.onload = () => resolve(img);
                        img.onerror = () => reject(new Error('image could not be read'));
                        img.src = url;
                    });
                    const { width, height } = fitWithin(image.naturalWidth, image.naturalHeight);
                    const canvas = newCanvas(width, height);
                    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
                    pagesRef.current.set(1, { page: canvas, marks: null, points: { width, height } });
                    setPageCount(1);
                } finally {
                    URL.revokeObjectURL(url);
                }
            }
            if (cancelled) return;
            await showPage(1);
            if (!cancelled) setStatus('ready');
        };

        open().catch((err) => {
            console.error('Could not open the file for highlighting', err);
            if (cancelled) return;
            setStatus('error');
            setMessage(t(err?.name === 'PasswordException' ? 'student_highlighter_password' : 'student_highlighter_open_failed'));
        });

        return () => {
            cancelled = true;
            if (docRef.current) { docRef.current.destroy(); docRef.current = null; }
        };
        // showPage only changes with isPdf (derived from file), so file is the real dependency
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file, kind]);

    // --- Drawing (mouse, touch and stylus) ---
    const pointFrom = (event) => {
        const canvas = markCanvasRef.current;
        const rect = canvas.getBoundingClientRect();
        return { x: (event.clientX - rect.left) * (canvas.width / rect.width), y: (event.clientY - rect.top) * (canvas.height / rect.height) };
    };

    const drawSegment = (from, to) => {
        const ctx = markCanvasRef.current.getContext('2d');
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = tool === 'eraser' ? ERASER_WIDTH : MARKER_WIDTH;
        ctx.strokeStyle = MARK_COLOR;
        // The eraser only removes marks: the page itself is on another canvas
        ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
    };

    const handlePointerDown = (event) => {
        if (status !== 'ready' || pageLoading) return;
        event.preventDefault();
        markCanvasRef.current.setPointerCapture(event.pointerId);
        const point = pointFrom(event);
        strokeRef.current = { pointerId: event.pointerId, last: point };
        drawSegment(point, { x: point.x + 0.01, y: point.y }); // a single tap leaves a dot
    };

    const handlePointerMove = (event) => {
        const stroke = strokeRef.current;
        if (!stroke || stroke.pointerId !== event.pointerId) return;
        const point = pointFrom(event);
        drawSegment(stroke.last, point);
        stroke.last = point;
    };

    // After each stroke the page's marks are stored, so "pages that will be saved" stays current
    const endStroke = (event) => {
        if (!strokeRef.current || strokeRef.current.pointerId !== event.pointerId) return;
        strokeRef.current = null;
        keepShownMarks();
        updateMarked();
    };

    const clearPage = () => {
        const canvas = markCanvasRef.current;
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        keepShownMarks();
        updateMarked();
    };

    // --- Saving ---
    const handleSave = async () => {
        keepShownMarks();
        updateMarked();
        setStatus('saving');
        setMessage('');
        try {
            if (!isPdf) {
                // A photo stays a (high-quality) JPEG; anything else becomes a PNG
                const entry = pagesRef.current.get(1);
                const jpeg = file.type === 'image/jpeg';
                const bytes = await canvasBytes(flatten(entry.page, entry.marks), jpeg ? 'image/jpeg' : 'image/png', 0.92);
                await onSave(new Blob([bytes], { type: jpeg ? 'image/jpeg' : 'image/png' }), highlightedName(file.name, jpeg ? 'jpg' : 'png'));
            } else {
                const marked = [...pagesRef.current.entries()].filter(([, e]) => e.marks).map(([n]) => n);
                const keep = pagesToKeep(marked);
                const { bytes } = await buildHighlightedPdf({
                    originalBytes: bytesRef.current,
                    keep,
                    totalPages: pageCount,
                    pageSize: (number) => pagesRef.current.get(number).points,
                    overlayPng: async (number) => {
                        const marks = pagesRef.current.get(number)?.marks;
                        return marks ? canvasBytes(marks, 'image/png') : null;
                    },
                    // Only needed for protected PDFs: pages are re-rendered one at a time
                    flattenedJpeg: async (number) => {
                        const entry = await renderPage(number);
                        const bytes = await canvasBytes(flatten(entry.page, entry.marks), 'image/jpeg', 0.9);
                        if (number !== shownRef.current) entry.page = null;
                        return bytes;
                    },
                });
                await onSave(new Blob([bytes], { type: 'application/pdf' }), highlightedName(file.name, 'pdf'));
            }
        } catch (err) {
            console.error('Could not create the highlighted file', err);
            setMessage(t('student_highlighter_save_failed'));
        }
        setStatus((current) => (current === 'saving' ? 'ready' : current));
    };

    const toolButton = (name, label) => (
        <button
            type="button" onClick={() => setTool(name)} aria-pressed={tool === name}
            style={{ ...smallButton, backgroundColor: tool === name ? 'var(--control-active)' : 'var(--surface)' }}
        >
            {label}
        </button>
    );

    const multiPage = isPdf && pageCount > 1;
    const navDisabled = status !== 'ready' || pageLoading;

    return (
        <div style={{ marginTop: '10px' }}>
            {status === 'loading' && <p role="status">{t('student_highlighter_loading')}</p>}
            {message && <p role="alert" style={{ color: 'var(--error-text)', fontWeight: 'bold' }}>{message}</p>}

            {status !== 'error' && (
                <>
                    <div style={{ display: 'flex', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
                        {toolButton('marker', t('student_tool_highlighter'))}
                        {toolButton('eraser', t('student_tool_eraser'))}
                        <button type="button" onClick={clearPage} style={{ ...smallButton, backgroundColor: 'var(--red)', color: 'white', border: 'none' }}>{t('student_tool_clear_page')}</button>
                        <button type="button" onClick={onCancel} style={{ ...smallButton, backgroundColor: 'var(--grey)', color: 'white', border: 'none' }}>{t('student_remove_selected_file')}</button>
                    </div>

                    {multiPage && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '8px' }}>
                            <button type="button" onClick={() => showPage(pageNumber - 1)} disabled={navDisabled || pageNumber <= 1} style={smallButton}>◀ {t('student_highlighter_prev')}</button>
                            {/* Announced by screen readers when the page changes */}
                            <span role="status" aria-live="polite" style={{ fontWeight: 'bold', minWidth: '120px', textAlign: 'center' }}>
                                {pageLoading ? t('student_highlighter_page_loading') : t('student_highlighter_page', { page: pageNumber, total: pageCount })}
                            </span>
                            <button type="button" onClick={() => showPage(pageNumber + 1)} disabled={navDisabled || pageNumber >= pageCount} style={smallButton}>{t('student_highlighter_next')} ▶</button>
                        </div>
                    )}

                    {/* The page and its marks: the marks canvas is see-through and blended like a highlighter pen */}
                    <div style={{ position: 'relative', width: '100%', maxWidth: '820px', margin: '0 auto', border: '1px solid var(--border-strong)', lineHeight: 0 }}>
                        <canvas ref={pageCanvasRef} role="img" aria-label={t('student_highlighter_page_label', { page: pageNumber, total: pageCount })} style={{ width: '100%', height: 'auto', display: 'block' }} />
                        <canvas
                            ref={markCanvasRef}
                            onPointerDown={handlePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerUp={endStroke}
                            onPointerCancel={endStroke}
                            style={{
                                position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                                opacity: MARK_OPACITY, mixBlendMode: 'multiply',
                                touchAction: 'none', // drawing with a finger must not scroll the page
                                cursor: tool === 'eraser' ? 'cell' : 'crosshair',
                            }}
                        />
                    </div>

                    {isPdf && (
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '8px 0 0 0' }}>
                            {t('student_highlighter_saved_pages', { pages: pagesToKeep(markedPages).join(', ') })}
                        </p>
                    )}

                    <button
                        type="button" onClick={handleSave} disabled={status !== 'ready' || pageLoading}
                        style={{ marginTop: '10px', padding: '8px 15px', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: '4px', cursor: status === 'ready' ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}
                    >
                        {status === 'saving' ? t('student_upload_saving') : t('student_save_highlighted')}
                    </button>
                </>
            )}
            {status === 'error' && (
                <button type="button" onClick={onCancel} style={{ ...smallButton, backgroundColor: 'var(--grey)', color: 'white', border: 'none' }}>{t('student_remove_selected_file')}</button>
            )}
        </div>
    );
};

export default EvidenceHighlighter;
