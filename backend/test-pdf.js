// Step 1 check for the term archiver: draws a one-page test PDF to disk.
// Run: node test-pdf.js   ->  creates test-pdf-output.pdf in this folder
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
const OUTPUT = path.join(__dirname, 'test-pdf-output.pdf');
const MM = 72 / 25.4; // PDF points per millimetre

const doc = new PDFDocument({ size: 'A4', margin: 20 * MM });
doc.pipe(fs.createWriteStream(OUTPUT));

// Noto Sans covers Hungarian (ő, ű) and German (ä, ö, ü, ß)
doc.registerFont('Body', path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
doc.registerFont('Bold', path.join(FONT_DIR, 'NotoSans-Bold.ttf'));

// Header: semester range, like every page of the real book
doc.font('Body').fontSize(9).fillColor('#666666')
    .text('Semester: 2026-02-01 – 2026-06-30', { align: 'right' });
doc.moveDown(2);

doc.font('Bold').fontSize(20).fillColor('#004085').text('PTE Kreditátvitel – test page');
doc.moveDown();

doc.font('Body').fontSize(12).fillColor('#000000')
    .text('Hungarian: árvíztűrő tükörfúrógép — ÁRVÍZTŰRŐ TÜKÖRFÚRÓGÉP (ő, ű, Ő, Ű)')
    .moveDown(0.5)
    .text('German: Größe, Prüfer, Übertragung, schön, Straße')
    .moveDown(0.5)
    .text('English: Credit transfer application archive');
doc.moveDown();
doc.font('Bold').text('Bold: Elfogadva · Genehmigt · Approved — ő ű');

// Footer inside the bottom margin. pdfkit starts a new page for text below the
// margin, so lift the margin while drawing the footer, then put it back.
const bottomMargin = doc.page.margins.bottom;
doc.page.margins.bottom = 0;
const footerY = doc.page.height - 12 * MM;
doc.font('Body').fontSize(9).fillColor('#666666')
    .text('Page 1 of 1', 20 * MM, footerY, { width: doc.page.width - 40 * MM, align: 'center', lineBreak: false });
doc.page.margins.bottom = bottomMargin;

doc.end();
console.log(`✅ Test PDF written to ${OUTPUT}`);
