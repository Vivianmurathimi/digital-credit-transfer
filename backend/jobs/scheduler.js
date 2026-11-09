const { runApplicationJobs, withJobsLock } = require('./applicationJobs');

// Runs the background jobs inside the backend: once at startup (which catches up on anything that
// passed while the server was off), then every 5 minutes. setInterval, not a cron library: every
// rule compares with "now" (a deadline passed, 7 days before the semester end...), never with a
// clock time, so a check every few minutes is always on time and needs no extra dependency.
// All state is in the database (see applicationJobs.js), so restarts are safe. Within one process a
// run never starts while the previous one is busy; across processes (a second backend, or
// `npm run jobs:run`) a Postgres advisory lock lets only one run at a time, the other skips its turn.

const EVERY_MS = 5 * 60 * 1000;

let timer = null;
let running = false;

const runOnce = async () => {
    if (running) return;
    running = true;
    try {
        const run = await withJobsLock(() => runApplicationJobs());
        if (run.skipped) console.log('⏱️  Background jobs skipped this turn: another process is running them.');
    } catch (err) {
        console.error('❌ Background jobs could not run:', err.message);
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
                '    No reminders and NO AUTOMATIC REJECTIONS will happen.',
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
    console.log(`⏱️  Background jobs running every ${EVERY_MS / 60000} minutes (semester end, reviewer reminders, deadline reminders, overdue information requests).`);
};

module.exports = { startJobs };
