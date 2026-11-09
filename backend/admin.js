/**
 * Creates the invite for the VERY FIRST admin (admin round Group 2). After that, admins invite
 * each other from the dashboard; this script then refuses to run.
 *
 *   npm run make-superadmin -- someone@example.com [--lang=hu|en|de]
 *   FIRST_ADMIN_EMAIL=someone@example.com npm run make-superadmin
 *
 * The address comes only from the command line or the FIRST_ADMIN_EMAIL variable, never from
 * the code. The script prints the invite link (and emails it); opening it, the person sets their
 * name and password, and the account is created verified as an admin. Nobody becomes an admin by
 * registering.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();
const pool = require('./db');
const inTransaction = require('./utils/transaction');
const { normalizeEmail } = require('./utils/rateLimit');
const { isValidInviteEmail, checkInviteAddress, createInvite, inviteLink, sendInviteEmail, INVITE_DAYS } = require('./utils/staffInvites');

const finish = (code, message) => {
    (code === 0 ? console.log : console.error)(message);
    // db.js keeps its startup test connection open, so exit explicitly
    process.exit(code);
};

const args = process.argv.slice(2);
const langArg = args.find((arg) => arg.startsWith('--lang='));
const emailArg = args.find((arg) => !arg.startsWith('--'));

const run = async () => {
    const email = normalizeEmail(emailArg || process.env.FIRST_ADMIN_EMAIL || '');
    if (!email) {
        return finish(1, 'Usage: npm run make-superadmin -- <email> [--lang=hu|en|de]   (or set FIRST_ADMIN_EMAIL)');
    }
    if (!isValidInviteEmail(email)) return finish(1, `"${email}" is not a valid email address.`);
    const language = langArg ? langArg.slice('--lang='.length) : 'hu';
    if (!['hu', 'en', 'de'].includes(language)) return finish(1, '--lang must be hu, en or de.');

    const result = await inTransaction(async (client) => {
        // Only for the first admin: with an active admin, invites are sent from the dashboard.
        // The lock makes two runs at the same moment wait for each other.
        await client.query("LOCK TABLE staff_invites IN SHARE ROW EXCLUSIVE MODE");
        const admins = (await client.query("SELECT count(*)::int AS n FROM users WHERE role = 'superadmin' AND deactivated_at IS NULL")).rows[0].n;
        if (admins > 0) return { error: 'An active admin already exists. Admins invite other admins from the dashboard (Staff access).' };

        const address = await checkInviteAddress(client, email, 'superadmin');
        if (address.error) return { error: `${email}: ${address.error[2]}.` };

        return createInvite(client, { email, role: 'superadmin', language });
    });
    if (result.error) return finish(1, result.error);

    await sendInviteEmail({ email, language, role: 'superadmin', token: result.token });
    return finish(0, [
        `Admin invite created for ${email} (valid ${INVITE_DAYS} days, works once; the email was sent too).`,
        'Open this link to set the name and password:',
        `  ${inviteLink(result.token)}`,
    ].join('\n'));
};

run().catch((err) => finish(1, `Database error: ${err.message}`));
