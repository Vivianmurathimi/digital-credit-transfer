// Step 4 check for the term archiver: builds the term book from the database and saves it to disk.
// Run: node test-term-book.js 2026-01-01 2026-12-31   ->  creates test-term-book.pdf in this folder
const fs = require('fs');
const path = require('path');
const getTermData = require('./utils/getTermData');
const buildTermBookPdf = require('./utils/buildTermBookPdf');

const [from = '2026-01-01', to = '2026-12-31'] = process.argv.slice(2);
const OUTPUT = path.join(__dirname, 'test-term-book.pdf');

(async () => {
    const data = await getTermData(from, to);
    const { buffer, pages, embeddedImages } = await buildTermBookPdf(data);
    fs.writeFileSync(OUTPUT, buffer);
    console.log(`✅ ${data.total} applications, ${pages} pages, ${embeddedImages} images, ${Math.round(buffer.length / 1024)} KB`);
    console.log(`   Saved to ${OUTPUT}`);
    process.exit(0);
})().catch((err) => {
    console.error('❌ Could not build the term book:', err);
    process.exit(1);
});
