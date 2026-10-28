/**
 * Promotes an existing, verified account to superadmin.
 * This is the safe way to create the first superadmin (also in production):
 * register normally, verify the email, then run on the server:
 *
 *   npm run make-superadmin -- someone@adminisztracio.pte.hu
 *
 * It never creates accounts and never touches unverified ones.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();
const pool = require('./db');

const finish = (code, message) => {
    (code === 0 ? console.log : console.error)(message);
    // db.js keeps its startup test connection open, so exit explicitly
    process.exit(code);
};

const promote = async () => {
    const email = (process.argv[2] || '').trim().toLowerCase();
    if (!email) return finish(1, 'Usage: npm run make-superadmin -- <email of a registered, verified account>');

    const { rows } = await pool.query('SELECT id, name, role, is_verified FROM users WHERE email = $1', [email]);
    if (rows.length === 0) return finish(1, `No account with the email ${email}. Register it first, then run this again.`);

    const user = rows[0];
    if (!user.is_verified) return finish(1, `${email} has not verified its email yet. Verify it first, then run this again.`);
    if (user.role === 'superadmin') return finish(0, `${user.name} (${email}) is already a superadmin. Nothing changed.`);

    await pool.query("UPDATE users SET role = 'superadmin' WHERE id = $1", [user.id]);
    return finish(0, `${user.name} (${email}) was ${user.role} and is now superadmin.`);
};

promote().catch((err) => finish(1, `Database error: ${err.message}`));
