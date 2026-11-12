const { getSemesterTermData, getApplicationTermData } = require('./getTermData');
const buildTermBookPdf = require('./buildTermBookPdf');
const { contentDisposition } = require('./fileRules');

// PDFs made on request (round 2 Group 1): a reviewer's book of their programmes, and one
// application's PDF (reviewers and admins). Same layout as the admin's book (utils/buildTermBookPdf.js);
// nothing is stored. Who may have which one is checked by the routes, on the server.

const sendPdf = (res, fileName, buffer) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(fileName));
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
};

// A file name without characters that cause trouble in a download
const safeName = (text) => String(text || '').replace(/[^\p{L}\p{N} ._-]+/gu, '-').replace(/\s+/g, '_').slice(0, 80);

/**
 * A reviewer's book of one semester: only their visible programmes, without withdrawn applications;
 * marked interim while the semester isn't closed.
 * @param {{ id, name }} semester
 * @param {Array<{ programme_id, code }>} programmes  the reviewer's visible programmes
 */
const reviewerBook = async (semester, programmes) => {
    const data = await getSemesterTermData(semester.id, {
        programmeIds: programmes.map((p) => p.programme_id), programmes: programmes.map((p) => p.code),
    });
    const { buffer } = await buildTermBookPdf(data);
    const fileName = `${safeName(semester.name)}_${programmes.map((p) => p.code).join('-')}${data.interim ? '_interim' : ''}.pdf`;
    return { buffer, fileName };
};

// One application's PDF, or null when it doesn't exist
const applicationPdf = async (applicationId) => {
    const data = await getApplicationTermData(applicationId);
    if (!data || data.applications.length === 0) return null;
    const { buffer } = await buildTermBookPdf(data);
    return { buffer, fileName: `application_${applicationId}${data.interim ? '_interim' : ''}.pdf` };
};

module.exports = { sendPdf, reviewerBook, applicationPdf };
