/**
 * Creates a semester and its application period (Group 3; admin screens come later).
 *
 *   npm run semester:create -- --name "2026/27 Autumn" --apply-from 2026-09-01 --apply-until 2026-10-15 --ends 2027-01-31
 *
 * Days are calendar days in Budapest: students can submit from 00:00 on --apply-from until
 * 23:59:59 on --apply-until; after --ends, unreviewed applications are rejected automatically.
 * Refuses invalid days, days out of order and overlaps with another semester.
 * Courses that belong to no semester yet are added to the new one.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const pool = require('../db');
const { listPendingMigrations } = require('../utils/migrations');
const { createSemester } = require('../utils/semesters');

// --name "X" --apply-from Y ... -> { name: 'X', 'apply-from': 'Y', ... }
const readArgs = (argv) => {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : '';
    }
    return args;
};

const main = async () => {
    const pending = await listPendingMigrations();
    if (pending.length > 0) throw new Error(`pending migrations (${pending.join(', ')}). Run "npm run migrate" first.`);
    const args = readArgs(process.argv.slice(2));
    const { id, adoptedCourses } = await createSemester(pool, {
        name: args.name, applyFrom: args['apply-from'], applyUntil: args['apply-until'], ends: args.ends,
    });
    console.log(`Semester "${args.name.trim()}" created (id ${id}): applications ${args['apply-from']} to ${args['apply-until']}, ends ${args.ends} (Budapest time).`);
    console.log(`Courses without a semester added to it: ${adoptedCourses}.`);
};

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(`Semester not created: ${err.message}`);
        process.exit(1);
    });
