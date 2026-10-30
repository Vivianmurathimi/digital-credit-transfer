const { runApplicationJobs } = require('./applicationJobs');

// Runs the background jobs inside the backend: once at startup, then every few minutes.
// All state is in the database (see applicationJobs.js), so restarts and a second backend
// process are safe. Within one process a run never starts while the previous one is busy.

const EVERY_MS = 5 * 60 * 1000;

let timer = null;
let running = false;

const runOnce = async () => {
    if (running) return;
    running = true;
    try {
        await runApplicationJobs();
    } finally {
        running = false;
    }
};

// JOBS_DISABLED=1 switches them off (e.g. a throwaway backend for tests). In production that would
// silently stop reminders and automatic rejections, so it is reported as loudly as possible.
const startJobs = () => {
    if (process.env.JOBS_DISABLED === '1') {
        if (process.env.NODE_ENV === 'production') {
            console.error([
                '',
                '❌❌❌ BACKGROUND JOBS ARE SWITCHED OFF (JOBS_DISABLED=1) IN PRODUCTION ❌❌❌',
                '    No deadline reminders and NO AUTOMATIC REJECTIONS will happen.',
                '    Remove JOBS_DISABLED from backend/.env and restart, unless another process runs them.',
                '',
            ].join('\n'));
        } else {
            console.warn('⚠️  Background jobs are switched off (JOBS_DISABLED=1).');
        }
        return;
    }
    if (timer) return;
    runOnce();
    timer = setInterval(runOnce, EVERY_MS);
    console.log(`⏱️  Background jobs running every ${EVERY_MS / 60000} minutes (deadline reminders, overdue information requests).`);
};

module.exports = { startJobs };
