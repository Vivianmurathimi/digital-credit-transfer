const pool = require('../db');
const sendEmail = require('./sendEmail');
const { buildAdminEmail } = require('./emailTemplates');

/**
 * A programme's main reviewer left (removed, deactivated, taken off the programme, or became an
 * extra reviewer) and nobody replaced them (round 2 Group 1). When the programme still has extra
 * reviewers, every active admin gets one email, in their language: nobody is promoted
 * automatically, the admin chooses. Without extra reviewers nothing is sent (as before: the
 * Overview shows the programme without a reviewer).
 * Call it WITHOUT await, after the HTTP response: it never throws.
 * @param {number[]} programmeIds  the programmes whose main reviewer link just ended
 */
const notifyAdminsNoMainReviewer = async (programmeIds) => {
    try {
        if (!programmeIds || programmeIds.length === 0) return;
        const { rows: programmes } = await pool.query(
            `SELECT p.id, p.code, p.name_en, p.name_hu, p.name_de,
                    (SELECT string_agg(u.name, ', ' ORDER BY u.name) FROM staff_programmes sp JOIN users u ON u.id = sp.user_id AND u.deactivated_at IS NULL
                     WHERE sp.programme_id = p.id AND sp.role = 'extra' AND sp.ended_at IS NULL) AS extras
             FROM programmes p
             WHERE p.id = ANY($1)
               AND NOT EXISTS (SELECT 1 FROM staff_programmes m JOIN users mu ON mu.id = m.user_id AND mu.deactivated_at IS NULL
                               WHERE m.programme_id = p.id AND m.role = 'main' AND m.ended_at IS NULL)`,
            [[...new Set(programmeIds)]]
        );
        const waiting = programmes.filter((p) => p.extras);
        if (waiting.length === 0) return;
        const { rows: admins } = await pool.query(
            "SELECT name, email, preferred_language FROM users WHERE role = 'superadmin' AND deactivated_at IS NULL ORDER BY id"
        );
        for (const programme of waiting) {
            for (const admin of admins) {
                const lang = admin.preferred_language;
                const name = programme[`name_${lang}`] || programme.name_en;
                const email = buildAdminEmail('noMainReviewer', lang, { name: admin.name, programme: `${programme.code} – ${name}`, extras: programme.extras });
                if (email) await sendEmail({ email: admin.email, subject: email.subject, html: email.html });
            }
            console.log(`ℹ️  Programme ${programme.code} has no main reviewer (extra reviewers: ${programme.extras}): ${admins.length} admin(s) emailed`);
        }
    } catch (err) {
        console.error('❌ Admin notification (no main reviewer) failed:', err.message);
    }
};

module.exports = { notifyAdminsNoMainReviewer };
