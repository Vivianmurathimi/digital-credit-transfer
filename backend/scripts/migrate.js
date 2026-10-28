/**
 * Applies pending database migrations from backend/migrations.
 *
 *   npm run migrate
 *
 * Safe to run any time: already-applied migrations are skipped.
 * Also used on the production server after each deployment.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const { runPendingMigrations } = require('../utils/migrations');

runPendingMigrations()
    .then((applied) => {
        if (applied.length === 0) console.log('Database is up to date: no pending migrations.');
        else applied.forEach((file) => console.log(`Applied ${file}`));
        // db.js keeps its startup test connection open, so exit explicitly
        process.exit(0);
    })
    .catch((err) => {
        console.error(`Migration stopped: ${err.message}`);
        process.exit(1);
    });
