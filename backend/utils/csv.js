// CSV files for the admin (Past semesters, admin round Group 6; Analytics, Group 7), one format:
// ";" (Hungarian Excel), UTF-8 with a BOM (so Excel reads the accents), every cell quoted, CRLF.
// A cell starting with = + - @ gets a leading ' so a spreadsheet never runs it as a formula.

const cell = (value) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
};

// rows: arrays of values (the first one the header)
const toCsv = (rows) => `\uFEFF${rows.map((row) => row.map(cell).join(';')).join('\r\n')}\r\n`;

// A moment as "2026-11-10 14:30" in Budapest time
const budapest = (at) => (at ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Budapest', dateStyle: 'short', timeStyle: 'short' }).format(new Date(at)) : '');

// Sends a CSV download
const sendCsv = (res, fileName, rows) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]+/g, '-')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(toCsv(rows));
};

module.exports = { cell, toCsv, budapest, sendCsv };
