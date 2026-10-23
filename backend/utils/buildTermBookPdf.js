const path = require('path');
const PDFDocument = require('pdfkit');
const fetchEvidence = require('./fetchEvidence');

// --- Layout -------------------------------------------------------------
const MM = 72 / 25.4;               // PDF points per millimetre
const MARGIN = 20 * MM;             // A4 with 20 mm margins
const HEADER_Y = 10 * MM;           // header and footer sit inside the margins
const FOOTER_OFFSET = 12 * MM;
const INDEX_ROWS_PER_PAGE = 32;
const INDEX_ROW_HEIGHT = 18;
const TIMEZONE = 'Europe/Budapest';

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const COLORS = {
    brand: '#004085', text: '#000000', muted: '#666666', line: '#cccccc', panel: '#f0f4fa',
    status: { approved: '#0a58ca', pending: '#2f73cf', needs_info: '#fd7e14', rejected: '#dc3545' },
};
const STATUS_LABELS = { pending: 'Pending', needs_info: 'Needs Info', approved: 'Approved', rejected: 'Rejected' };
const NOTE_LABELS = [
    ['student', "Student's note"],
    ['system', 'System note (credit check)'],
    ['reviewer', "Reviewer's note"],
    ['resubmit', "Student's reply (missing info)"],
];
const NOT_EMBEDDED = {
    not_image: 'not an image, listed only',
    missing: 'file not found in storage',
    error: 'could not be loaded',
};

// --- Small helpers ------------------------------------------------------
// "2026-10-05 18:58" in Hungarian time; '—' when there is no date
const formatDateTime = (date) => (date
    ? new Date(date).toLocaleString('sv-SE', { timeZone: TIMEZONE, dateStyle: 'short', timeStyle: 'short' })
    : '—');
const statusLabel = (status) => STATUS_LABELS[status] || status || '—';
const statusColor = (status) => COLORS.status[status] || COLORS.text;
const contentWidth = (doc) => doc.page.width - 2 * MARGIN;
const currentPageIndex = (doc) => {
    const range = doc.bufferedPageRange();
    return range.start + range.count - 1;
};

// Writes outside the normal margins (header/footer) without pdfkit starting a new page
const writeInMargin = (doc, text, y, options) => {
    const { top, bottom } = doc.page.margins;
    doc.page.margins.top = 0;
    doc.page.margins.bottom = 0;
    doc.text(text, MARGIN, y, { width: contentWidth(doc), lineBreak: false, ...options });
    doc.page.margins.top = top;
    doc.page.margins.bottom = bottom;
};

const heading = (doc, text) => {
    doc.moveDown(0.8);
    doc.font('Bold').fontSize(12).fillColor(COLORS.brand).text(text, MARGIN);
    doc.moveDown(0.3);
};

// Two-column "label: value" rows
const detailRows = (doc, rows) => {
    const labelWidth = 130;
    rows.forEach(([label, value, color]) => {
        const y = doc.y;
        doc.font('Bold').fontSize(10).fillColor(COLORS.muted).text(label, MARGIN, y, { width: labelWidth });
        doc.font('Body').fontSize(10).fillColor(color || COLORS.text)
            .text(value || '—', MARGIN + labelWidth, y, { width: contentWidth(doc) - labelWidth });
        doc.moveDown(0.25);
    });
};

// --- Pages --------------------------------------------------------------
const drawCover = (doc, data) => {
    doc.y = MARGIN + 60;
    doc.font('Bold').fontSize(26).fillColor(COLORS.brand).text('Credit Transfer Archive', MARGIN, doc.y, { align: 'center' });
    doc.moveDown(0.3);
    doc.font('Body').fontSize(13).fillColor(COLORS.muted).text('PTE Credit Transfer System', { align: 'center' });
    doc.moveDown(2.5);

    doc.font('Bold').fontSize(14).fillColor(COLORS.text).text(`Semester: ${data.from} – ${data.to}`, { align: 'center' });
    doc.moveDown(0.4);
    doc.font('Body').fontSize(11).fillColor(COLORS.muted).text(`Generated: ${formatDateTime(data.generatedAt)}`, { align: 'center' });
    doc.moveDown(3);

    // Totals by status
    const tableWidth = 260;
    const x = (doc.page.width - tableWidth) / 2;
    doc.font('Bold').fontSize(12).fillColor(COLORS.brand).text('Applications by status', x, doc.y, { width: tableWidth });
    doc.moveDown(0.5);
    const rows = [...Object.entries(data.totals).map(([status, count]) => [statusLabel(status), count, statusColor(status)]),
        ['Total', data.total, COLORS.text]];
    rows.forEach(([label, count, color], i) => {
        const y = doc.y;
        const isTotal = i === rows.length - 1;
        if (isTotal) doc.moveTo(x, y - 3).lineTo(x + tableWidth, y - 3).strokeColor(COLORS.line).stroke();
        doc.font(isTotal ? 'Bold' : 'Body').fontSize(11).fillColor(color).text(label, x, y, { width: tableWidth - 60 });
        doc.font('Bold').fillColor(COLORS.text).text(String(count), x + tableWidth - 60, y, { width: 60, align: 'right' });
        doc.moveDown(0.4);
    });
};

// Index pages are reserved first and filled in at the end, once page numbers are known
const indexPageCount = (data) => Math.max(1, Math.ceil(data.applications.length / INDEX_ROWS_PER_PAGE));

const drawIndex = (doc, data, firstIndexPage, startPages) => {
    const cols = [
        { title: '#', width: 35 },
        { title: 'Student', width: 165 },
        { title: 'Submitted', width: 110 },
        { title: 'Status', width: 85 },
        { title: 'Page', width: 0, align: 'right' }, // takes the rest
    ];
    cols[cols.length - 1].width = contentWidth(doc) - cols.slice(0, -1).reduce((sum, c) => sum + c.width, 0);

    const drawRow = (values, y, { bold = false, colors = [] } = {}) => {
        let x = MARGIN;
        cols.forEach((col, i) => {
            doc.font(bold ? 'Bold' : 'Body').fontSize(10).fillColor(colors[i] || COLORS.text)
                .text(String(values[i]), x, y, { width: col.width - 6, align: col.align || 'left', lineBreak: false, ellipsis: true });
            x += col.width;
        });
    };

    for (let p = 0; p < indexPageCount(data); p += 1) {
        doc.switchToPage(firstIndexPage + p);
        let y = MARGIN;
        if (p === 0) {
            doc.font('Bold').fontSize(18).fillColor(COLORS.brand).text('Index', MARGIN, y);
            y = doc.y + 10;
        }
        drawRow(cols.map((c) => c.title), y, { bold: true, colors: cols.map(() => COLORS.muted) });
        y += INDEX_ROW_HEIGHT;
        doc.moveTo(MARGIN, y - 4).lineTo(MARGIN + contentWidth(doc), y - 4).strokeColor(COLORS.line).stroke();

        const pageApps = data.applications.slice(p * INDEX_ROWS_PER_PAGE, (p + 1) * INDEX_ROWS_PER_PAGE);
        if (data.applications.length === 0) {
            doc.font('Body').fontSize(11).fillColor(COLORS.muted).text('No applications were submitted in this period.', MARGIN, y + 6);
        }
        pageApps.forEach((app) => {
            drawRow([app.id, app.student.name, formatDateTime(app.submittedAt), statusLabel(app.status), startPages[app.id] + 1], y,
                { colors: [null, null, null, statusColor(app.status)] });
            y += INDEX_ROW_HEIGHT;
        });
    }
};

const drawApplication = (doc, app, evidenceResults) => {
    // Title + status
    doc.font('Bold').fontSize(18).fillColor(COLORS.brand).text(`Application #${app.id}`, MARGIN, MARGIN);
    doc.font('Bold').fontSize(12).fillColor(statusColor(app.status)).text(statusLabel(app.status).toUpperCase());

    heading(doc, 'Student');
    detailRows(doc, [
        ['Name', app.student.name],
        ['Email', app.student.email],
        ['Submitted', formatDateTime(app.submittedAt)],
    ]);

    heading(doc, 'Decision');
    detailRows(doc, [
        ['Status', statusLabel(app.status), statusColor(app.status)],
        ['Reviewed by', app.reviewer ? `${app.reviewer.name} (${app.reviewer.email})` : '—'],
        ['Decision date', formatDateTime(app.reviewedAt)],
    ]);

    heading(doc, 'Fulfilled courses');
    if (app.courses.length === 0) {
        doc.font('Body').fontSize(10).fillColor(COLORS.muted).text('—', MARGIN);
    }
    app.courses.forEach((course, i) => {
        doc.font('Bold').fontSize(10).fillColor(COLORS.text).text(`${i + 1}. ${course.course_name || '—'}`, MARGIN);
        doc.font('Body').fontSize(9).fillColor(COLORS.muted)
            .text(`Code: ${course.course_code || '—'}   |   Credits: ${course.credits || '—'}   |   Grade: ${course.grade || '—'}`, MARGIN + 12);
        doc.moveDown(0.3);
    });

    heading(doc, 'Target PTE courses');
    doc.font('Body').fontSize(10).fillColor(COLORS.text);
    if (app.pteCourses.length === 0) doc.text('—', MARGIN);
    app.pteCourses.forEach((name) => doc.text(`• ${name}`, MARGIN));

    heading(doc, 'Notes');
    NOTE_LABELS.forEach(([key, label]) => {
        const note = app.notes[key];
        doc.font('Bold').fontSize(10).fillColor(COLORS.muted).text(label, MARGIN);
        doc.font('Body').fontSize(10).fillColor(note ? COLORS.text : COLORS.muted).text(note || '—', MARGIN + 12);
        doc.moveDown(0.4);
    });

    heading(doc, 'Evidence');
    doc.font('Body').fontSize(10).fillColor(COLORS.text);
    if (app.evidence.length === 0) doc.fillColor(COLORS.muted).text('No evidence files.', MARGIN);
    app.evidence.forEach((item, i) => {
        const result = evidenceResults[i];
        const where = result.embeddable ? 'on the following pages' : NOT_EMBEDDED[result.reason];
        doc.fillColor(COLORS.text).text(`${i + 1}. ${item.label} — ${item.file} (${where})`, MARGIN);
    });
};

const drawEvidencePage = (doc, app, item, result) => {
    doc.addPage();
    doc.font('Bold').fontSize(12).fillColor(COLORS.brand)
        .text(`Application #${app.id} — Evidence: ${item.label}`, MARGIN, MARGIN, { width: contentWidth(doc) });
    doc.font('Body').fontSize(9).fillColor(COLORS.muted).text(item.file, { width: contentWidth(doc) });
    doc.moveDown(0.5);

    const top = doc.y;
    const maxHeight = doc.page.height - MARGIN - top;
    try {
        doc.image(result.buffer, MARGIN, top, { fit: [contentWidth(doc), maxHeight], align: 'center', valign: 'top' });
    } catch (err) {
        doc.font('Body').fontSize(10).fillColor(COLORS.status.rejected).text(`This image could not be drawn (${err.message}).`, MARGIN, top);
    }
};

// Header (semester) and footer (Page X of Y) on every page, drawn last so the total is known
const drawHeadersAndFooters = (doc, data) => {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
        doc.switchToPage(i);
        doc.font('Body').fontSize(8).fillColor(COLORS.muted);
        writeInMargin(doc, `PTE Credit Transfer Archive · Semester ${data.from} – ${data.to}`, HEADER_Y, { align: 'right' });
        writeInMargin(doc, `Page ${i + 1} of ${range.count}`, doc.page.height - FOOTER_OFFSET, { align: 'center' });
    }
};

/**
 * Draws the term book: cover, index, then each application followed by its evidence images.
 * Evidence is loaded one file at a time.
 *
 * @param {object} data  result of getTermData(from, to)
 * @returns {Promise<{ buffer: Buffer, pages: number, embeddedImages: number }>}
 */
const buildTermBookPdf = (data) => new Promise((resolve, reject) => {
    const doc = new PDFDocument({
        size: 'A4',
        margin: MARGIN,
        bufferPages: true, // needed to go back and fill in the index, headers and footers
        info: {
            Title: `Credit Transfer Archive ${data.from} – ${data.to}`,
            Author: 'PTE Credit Transfer System',
            CreationDate: data.generatedAt,
        },
    });

    const chunks = [];
    let pages = 0;
    let embeddedImages = 0;
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), pages, embeddedImages }));
    doc.on('error', reject);

    doc.registerFont('Body', path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
    doc.registerFont('Bold', path.join(FONT_DIR, 'NotoSans-Bold.ttf'));

    const run = async () => {
        drawCover(doc, data);

        // Reserve the index pages; they are filled in once page numbers are known
        const firstIndexPage = currentPageIndex(doc) + 1;
        for (let i = 0; i < indexPageCount(data); i += 1) doc.addPage();

        const startPages = {};
        for (const app of data.applications) {
            doc.addPage();
            startPages[app.id] = currentPageIndex(doc);

            const evidenceResults = [];
            for (const item of app.evidence) evidenceResults.push(await fetchEvidence(item.file));

            drawApplication(doc, app, evidenceResults);
            app.evidence.forEach((item, i) => {
                if (!evidenceResults[i].embeddable) return;
                drawEvidencePage(doc, app, item, evidenceResults[i]);
                embeddedImages += 1;
                evidenceResults[i].buffer = null; // free the image as soon as it is drawn
            });
        }

        drawIndex(doc, data, firstIndexPage, startPages);
        drawHeadersAndFooters(doc, data);
        pages = doc.bufferedPageRange().count;
        doc.end();
    };

    run().catch((err) => {
        reject(err);
        doc.end();
    });
});

module.exports = buildTermBookPdf;
