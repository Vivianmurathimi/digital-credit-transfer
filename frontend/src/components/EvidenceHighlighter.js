import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as pdfjsLib from 'pdfjs-dist';
import { MARK_COLOR, MARK_OPACITY, fitWithin, hasVisibleMarks, pagesToKeep, buildHighlightedPdf } from '../highlighter';

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

// A canvas as file bytes
const canvasBytes = (canvas, type, quality) => new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject) : reject(new Error('empty canvas'))), type, quality);
});

// The page with its marks merged in, the way they look on screen (see-through, multiply)
const flatten = (entry) => {
    const canvas = newCanvas(entry.page.width, entry.page.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(entry.page, 0, 0);
    ctx.globalAlpha = MARK_OPACITY;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(entry.marks, 0, 0);
    return canvas;
};

const marksVisible = (entry) => hasVisibleMarks(entry.marks.getContext('2d').getImageData(0, 0, entry.marks.width, entry.marks.height).data);

/**
 * Highlighter for one syllabus file (PDF, or a photo/scan as JPG/PNG).
 * Used by the application form and the "add missing info" window.
 *
 * Each page has its own mark layer, kept in page pixels (not screen pixels), so marks stay
 * aligned when the window is resized and the saved file is as sharp as the rendered page.
 * Saving hands the finished file to onSave(blob, fileName); uploading is up to the caller.
 */
const EvidenceHighlighter = ({ file, onSave, onCancel }) => {
    const { t } = useTranslation();
    const [status, setStatus] = useState('loading'); // loading | ready | saving | error
    const [message, setMessage] = useState('');
    const [tool, setTool] = useState('marker');
    const [pageNumber, setPageNumber] = useState(1);
    const [pageCount, setPageCount] = useState(1);

    const pageCanvasRef = useRef(null);   // on screen: the current page
    const markCanvasRef = useRef(null);   // on screen: the current page's marks (drawn on)
    const docRef = useRef(null);          // pdf.js document (PDFs only)
    const bytesRef = useRef(null);        // the original PDF
    const pagesRef = useRef(new Map());   // page number -> { page, marks, points: { width, height } }
    const shownRef = useRef(null);        // page number currently on screen
    const strokeRef = useRef(null);       // { pointerId, last: { x, y } } while drawing
    const isPdf = file.type === 'application/pdf';

    // Copies the on-screen marks back into their page's own layer
    const keepShownMarks = useCallback(() => {
        const entry = pagesRef.current.get(shownRef.current);
        if (!entry || !markCanvasRef.current) return;
        const ctx = entry.marks.getContext('2d');
        ctx.clearRect(0, 0, entry.marks.width, entry.marks.height);
        ctx.drawImage(markCanvasRef.current, 0, 0);
    }, []);

    // Renders a page once (PDF) and remembers it with an empty mark layer
    const loadPage = useCallback(async (number) => {
        if (pagesRef.current.has(number)) return pagesRef.current.get(number);
        const page = await docRef.current.getPage(number);
        const points = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(RENDER_SCALE, MAX_RENDER_WIDTH / points.width) });
        const canvas = newCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const entry = { page: canvas, marks: newCanvas(canvas.width, canvas.height), points: { width: points.width, height: points.height } };
        pagesRef.current.set(number, entry);
        return entry;
    }, []);

    // Puts a page and its marks on screen
    const showPage = useCallback(async (number) => {
        keepShownMarks();
        const entry = isPdf ? await loadPage(number) : pagesRef.current.get(1);
        const pageCanvas = pageCanvasRef.current;
        const markCanvas = markCanvasRef.current;
        if (!pageCanvas || !markCanvas) return;
        pageCanvas.width = markCanvas.width = entry.page.width;
        pageCanvas.height = markCanvas.height = entry.page.height;
        pageCanvas.getContext('2d').drawImage(entry.page, 0, 0);
        markCanvas.getContext('2d').drawImage(entry.marks, 0, 0);
        shownRef.current = number;
        setPageNumber(number);
    }, [isPdf, keepShownMarks, loadPage]);

    // Open the file
    useEffect(() => {
        let cancelled = false;
        pagesRef.current = new Map();
        shownRef.current = null;
        setStatus('loading');
        setMessage('');

        const open = async () => {
            if (isPdf) {
                const bytes = new Uint8Array(await file.arrayBuffer());
                bytesRef.current = bytes;
                // pdf.js takes over the bytes it is given, so it gets its own copy
                const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
                if (cancelled) { doc.destroy(); return; }
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
                    pagesRef.current.set(1, { page: canvas, marks: newCanvas(width, height), points: { width, height } });
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
    }, [file]);

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
        if (status !== 'ready') return;
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

    const endStroke = (event) => {
        if (strokeRef.current && strokeRef.current.pointerId === event.pointerId) strokeRef.current = null;
    };

    const clearPage = () => {
        const canvas = markCanvasRef.current;
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    };

    // --- Saving ---
    const handleSave = async () => {
        keepShownMarks();
        setStatus('saving');
        setMessage('');
        try {
            const stamp = Date.now();
            if (!isPdf) {
                // A photo stays a (high-quality) JPEG; anything else becomes a PNG
                const jpeg = file.type === 'image/jpeg';
                const bytes = await canvasBytes(flatten(pagesRef.current.get(1)), jpeg ? 'image/jpeg' : 'image/png', 0.92);
                await onSave(new Blob([bytes], { type: jpeg ? 'image/jpeg' : 'image/png' }), `highlighted-${stamp}.${jpeg ? 'jpg' : 'png'}`);
            } else {
                const marked = [...pagesRef.current.entries()].filter(([, entry]) => marksVisible(entry)).map(([number]) => number);
                const keep = pagesToKeep(marked);
                for (const number of keep) await loadPage(number); // page 1 may not be rendered in rare cases
                const { bytes } = await buildHighlightedPdf({
                    originalBytes: bytesRef.current,
                    keep,
                    totalPages: pageCount,
                    pageSize: (number) => pagesRef.current.get(number).points,
                    overlayPng: async (number) => (marked.includes(number) ? canvasBytes(pagesRef.current.get(number).marks, 'image/png') : null),
                    flattenedJpeg: async (number) => canvasBytes(flatten(pagesRef.current.get(number)), 'image/jpeg', 0.9),
                });
                await onSave(new Blob([bytes], { type: 'application/pdf' }), `highlighted-${stamp}.pdf`);
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
            style={{ padding: '5px 10px', backgroundColor: tool === name ? 'var(--control-active)' : 'var(--surface)', border: '1px solid var(--control-border)', borderRadius: '4px', cursor: 'pointer' }}
        >
            {label}
        </button>
    );

    return (
        <div style={{ marginTop: '10px' }}>
            {status === 'loading' && <p role="status">{t('student_highlighter_loading')}</p>}
            {message && <p role="alert" style={{ color: 'var(--error-text)', fontWeight: 'bold' }}>{message}</p>}

            {status !== 'error' && (
                <>
                    <div style={{ display: 'flex', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
                        {toolButton('marker', t('student_tool_highlighter'))}
                        {toolButton('eraser', t('student_tool_eraser'))}
                        <button type="button" onClick={clearPage} style={{ padding: '5px 10px', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>{t('student_tool_clear_page')}</button>
                        <button type="button" onClick={onCancel} style={{ padding: '5px 10px', backgroundColor: 'var(--grey)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>{t('student_remove_selected_file')}</button>
                    </div>
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
                    <button
                        type="button" onClick={handleSave} disabled={status !== 'ready'}
                        style={{ marginTop: '10px', padding: '8px 15px', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: '4px', cursor: status === 'ready' ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}
                    >
                        {status === 'saving' ? t('student_upload_saving') : t('student_save_highlighted')}
                    </button>
                </>
            )}
            {status === 'error' && (
                <button type="button" onClick={onCancel} style={{ padding: '5px 10px', backgroundColor: 'var(--grey)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>{t('student_remove_selected_file')}</button>
            )}
        </div>
    );
};

export default EvidenceHighlighter;
