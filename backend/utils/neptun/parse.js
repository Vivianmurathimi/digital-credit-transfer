// A small CSV reader for the Neptun export (admin round Group 4). No library: the format is simple.
// - UTF-8; a byte order mark (Excel adds one) is removed; invalid UTF-8 is refused.
// - The delimiter is detected ONCE per file, from the header line: ";" (Hungarian Excel), "," or tab.
// - Quoted fields: "a;b" and "say ""hi""" (a quote inside is doubled); a quoted field may span lines.
// - Empty lines are skipped. Row numbers are the file's line numbers (the header is line 1).

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;
const DELIMITERS = [';', ',', '\t'];

class CsvError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

// The delimiter that appears most often in the header line outside quotes
const detectDelimiter = (headerLine) => {
    const counts = Object.fromEntries(DELIMITERS.map((d) => [d, 0]));
    let quoted = false;
    for (const ch of headerLine) {
        if (ch === '"') quoted = !quoted;
        else if (!quoted && ch in counts) counts[ch] += 1;
    }
    const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return count > 0 ? best : ';';
};

/**
 * @param {Buffer} buffer  the uploaded file
 * @returns {{ delimiter: string, header: string[], rows: { rowNumber: number, cells: string[] }[] }}
 * @throws {CsvError} CSV_TOO_LARGE, NOT_UTF8, EMPTY_FILE, TOO_MANY_ROWS, UNCLOSED_QUOTE
 */
const parseCsv = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new CsvError('EMPTY_FILE', 'The file is empty');
    if (buffer.length > MAX_BYTES) throw new CsvError('CSV_TOO_LARGE', 'The file is larger than 2 MB');
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        throw new CsvError('NOT_UTF8', 'The file is not UTF-8 text (save it as "CSV UTF-8")');
    }
    text = text.replace(/^\uFEFF/, '');
    const firstLineEnd = text.search(/\r?\n/);
    const delimiter = detectDelimiter(firstLineEnd === -1 ? text : text.slice(0, firstLineEnd));

    const records = []; // { rowNumber, cells }
    let cells = [];
    let cell = '';
    let quoted = false;
    let line = 1;
    let recordStart = 1;
    const endCell = () => { cells.push(cell); cell = ''; };
    const endRecord = () => {
        endCell();
        if (cells.some((c) => c.trim() !== '')) records.push({ rowNumber: recordStart, cells });
        if (records.length > MAX_ROWS + 1) throw new CsvError('TOO_MANY_ROWS', `The file has more than ${MAX_ROWS} rows`);
        cells = [];
    };
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
            else if (ch === '"') quoted = false;
            else { if (ch === '\n') line += 1; cell += ch; }
        } else if (ch === '"' && cell === '') {
            quoted = true;
        } else if (ch === delimiter) {
            endCell();
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i += 1;
            endRecord();
            line += 1;
            recordStart = line;
        } else {
            cell += ch;
        }
    }
    if (quoted) throw new CsvError('UNCLOSED_QUOTE', `A quote opened on line ${recordStart} is never closed`);
    endRecord();

    if (records.length === 0) throw new CsvError('EMPTY_FILE', 'The file is empty');
    const [headerRecord, ...rows] = records;
    return { delimiter, header: headerRecord.cells.map((h) => h.trim()), rows };
};

module.exports = { parseCsv, CsvError, MAX_BYTES, MAX_ROWS };
