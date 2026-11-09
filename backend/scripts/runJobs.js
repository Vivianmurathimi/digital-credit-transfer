/**
 * Runs the background jobs once, now (reviewer Group 7): the semester end, the reviewer reminders,
 * the students' deadline reminders and the overdue information requests. Real emails are sent.
 *
 *   npm run jobs:run
 *   npm run jobs:run -- --now=2027-01-31T08:00:00Z --yes      pretend it is that moment
 *
 * Uses the database in backend/.env, or another one given on the command line:
 *   DB_NAME=credit_db_test npm run jobs:run -- --now=... --yes
 *
 * A fake "now" really changes that database (rejections, reminders and history are saved with that
 * time), so it asks for --yes and is refused when NODE_ENV=production. Use it on a copy.
 * The run takes the same lock as the backend: if the backend is running the jobs at this moment,
 * this run is skipped (run it again a moment later).
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const pool = require('../db');
const { runApplicationJobs, withJobsLock } = require('../jobs/applicationJobs');

const args = process.argv.slice(2);
const nowArg = args.find((a) => a.startsWith('--now='));
const confirmed = args.includes('--yes');

const stop = (message) => {
    console.error(message);
    process.exit(1);
};

const main = async () => {
    const unknown = args.filter((a) => !a.startsWith('--now=') && a !== '--yes');
    if (unknown.length) stop(`Unknown option(s): ${unknown.join(' ')}. Use --now=<ISO time> and --yes.`);

    let now = new Date();
    if (nowArg) {
        if (process.env.NODE_ENV === 'production') stop('A fake time is not allowed with NODE_ENV=production.');
        now = new Date(nowArg.slice('--now='.length));
        if (Number.isNaN(now.getTime())) stop(`Not a valid time: ${nowArg}. Example: --now=2027-01-31T08:00:00Z (UTC) or --now=2027-01-31T09:00:00+01:00`);
        if (!confirmed) {
            stop([
                `This runs the jobs on database "${process.env.DB_NAME}" as if it were ${now.toISOString()}.`,
                'Rejections, reminders and their history are saved with that time, and real emails are sent.',
                'Add --yes to go ahead (best on a copy of the database).',
            ].join('\n'));
        }
    }

    const budapest = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Budapest', dateStyle: 'long', timeStyle: 'medium' }).format(now);
    console.log(`Running the background jobs on database "${process.env.DB_NAME}" at ${now.toISOString()} (${budapest} Budapest time)${nowArg ? ' [fake time]' : ''}`);
    const run = await withJobsLock(() => runApplicationJobs({ now }));
    if (run.skipped) stop('Skipped: another process (e.g. the backend) is running the jobs right now. Try again in a moment.');
    for (const [step, result] of Object.entries(run.result)) console.log(`  ${step}: ${result}`);
};

main()
    .then(() => pool.end())
    .catch(async (err) => {
        console.error(`Jobs failed: ${err.message}`);
        await pool.end().catch(() => {});
        process.exit(1);
    });
