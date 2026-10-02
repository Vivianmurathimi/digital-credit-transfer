// Email templates for student notifications, in HU / EN / DE.
// Kept in the backend (not shared with the frontend locale files) so the two projects stay separate.

const SUPPORTED_LANGUAGES = ['hu', 'en', 'de'];
const DEFAULT_LANGUAGE = 'hu';

// 'en-US' -> 'en'; anything unsupported or missing -> Hungarian
const normalizeLanguage = (lang) => {
    const short = String(lang || '').slice(0, 2).toLowerCase();
    return SUPPORTED_LANGUAGES.includes(short) ? short : DEFAULT_LANGUAGE;
};

// Makes user-written text safe to put inside HTML
const escapeHtml = (text) => String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Reviewer's message exactly as written: escaped, with line breaks kept
const formatNote = (note) => escapeHtml(note).replace(/\r?\n/g, '<br>');

// Same labels the app shows on screen (status_* keys in the frontend locales)
const statusLabels = {
    hu: { approved: 'Elfogadva', rejected: 'Elutasítva', pending: 'Folyamatban' },
    en: { approved: 'Approved', rejected: 'Rejected', pending: 'Pending' },
    de: { approved: 'Genehmigt', rejected: 'Abgelehnt', pending: 'Ausstehend' },
};

// Words shared by every template in a language
const common = {
    hu: { greeting: (name) => `Kedves ${name}!`, button: 'Irányítópult megnyitása', linkNote: 'Biztonsági okokból ez a link 10 percig érvényes. Ezután jelentkezzen be a szokásos módon.', noteTitle: 'A bíráló üzenete:', signature: 'PTE Kreditátvitel' },
    en: { greeting: (name) => `Dear ${name},`, button: 'Open my dashboard', linkNote: 'For your security, this link is valid for 10 minutes. After that, please log in as usual.', noteTitle: "Reviewer's message:", signature: 'PTE Credit Transfer' },
    de: { greeting: (name) => `Liebe/r ${name},`, button: 'Mein Dashboard öffnen', linkNote: 'Aus Sicherheitsgründen ist dieser Link 10 Minuten gültig. Danach melden Sie sich bitte wie gewohnt an.', noteTitle: 'Nachricht des Prüfers:', signature: 'PTE Kreditübertragung' },
};

const templates = {
    hu: {
        submitted: {
            subject: 'Kreditátviteli kérelmét megkaptuk',
            body: () => `<p>Kreditátviteli kérelmét sikeresen beküldte, és most bírálatra vár.</p>
                <p>E-mailt küldünk, amint a kérelem állapota megváltozik.</p>`,
        },
        resubmitted: {
            subject: 'A kiegészítő információkat megkaptuk',
            body: () => `<p>Köszönjük a kiegészítő információkat. Kérelme ismét bírálatra vár.</p>
                <p>E-mailt küldünk, amint a kérelem állapota megváltozik.</p>`,
        },
        needsInfo: {
            subject: 'Teendő: további információ szükséges a kérelméhez',
            body: () => `<p>A bírálónak további információra van szüksége, mielőtt döntést hozna kreditátviteli kérelméről.</p>`,
            after: () => `<p>Kérjük, jelentkezzen be, nyissa meg az <strong>Állapotom</strong> fület, és kattintson a <strong>Hiányzó információ hozzáadása</strong> gombra a válaszadáshoz és a dokumentumok feltöltéséhez.</p>`,
        },
        statusUpdate: {
            subject: 'Kreditátviteli kérelmének állapota megváltozott',
            body: ({ label }) => `<p>Kreditátviteli kérelmének állapota a következőre változott: <strong>${label}</strong>.</p>`,
            rejectedExtra: '<p>Ha kérdése van a döntéssel kapcsolatban, kérjük, forduljon a Tanulmányi Osztályhoz.</p>',
        },
    },
    en: {
        submitted: {
            subject: 'Your credit transfer application has been received',
            body: () => `<p>Your credit transfer application was submitted successfully and is now waiting for review.</p>
                <p>We will email you as soon as its status changes.</p>`,
        },
        resubmitted: {
            subject: 'Your additional information has been received',
            body: () => `<p>Thank you for sending the additional information. Your application is back in the review queue.</p>
                <p>We will email you as soon as its status changes.</p>`,
        },
        needsInfo: {
            subject: 'Action required: more information needed for your application',
            body: () => `<p>The reviewer needs more information before they can decide on your credit transfer application.</p>`,
            after: () => `<p>Please log in, open the <strong>My Status</strong> tab and click <strong>Add Missing Info</strong> to reply and upload documents.</p>`,
        },
        statusUpdate: {
            subject: 'Update on your credit transfer application',
            body: ({ label }) => `<p>The status of your credit transfer application has been updated to: <strong>${label}</strong>.</p>`,
            rejectedExtra: '<p>If you have questions about this decision, please contact the Student Office.</p>',
        },
    },
    de: {
        submitted: {
            subject: 'Ihr Antrag auf Kreditübertragung ist eingegangen',
            body: () => `<p>Ihr Antrag auf Kreditübertragung wurde erfolgreich eingereicht und wartet nun auf die Prüfung.</p>
                <p>Wir benachrichtigen Sie per E-Mail, sobald sich der Status ändert.</p>`,
        },
        resubmitted: {
            subject: 'Ihre zusätzlichen Informationen sind eingegangen',
            body: () => `<p>Vielen Dank für die zusätzlichen Informationen. Ihr Antrag befindet sich wieder in der Prüfung.</p>
                <p>Wir benachrichtigen Sie per E-Mail, sobald sich der Status ändert.</p>`,
        },
        needsInfo: {
            subject: 'Handlungsbedarf: weitere Informationen zu Ihrem Antrag erforderlich',
            body: () => `<p>Der Prüfer benötigt weitere Informationen, bevor über Ihren Antrag auf Kreditübertragung entschieden werden kann.</p>`,
            after: () => `<p>Bitte melden Sie sich an, öffnen Sie den Reiter <strong>Mein Status</strong> und klicken Sie auf <strong>Fehlende Informationen hinzufügen</strong>, um zu antworten und Dokumente hochzuladen.</p>`,
        },
        statusUpdate: {
            subject: 'Neuigkeiten zu Ihrem Antrag auf Kreditübertragung',
            body: ({ label }) => `<p>Der Status Ihres Antrags auf Kreditübertragung wurde geändert auf: <strong>${label}</strong>.</p>`,
            rejectedExtra: '<p>Bei Fragen zu dieser Entscheidung wenden Sie sich bitte an das Studierendensekretariat.</p>',
        },
    },
};

const noteBlock = (title, note) => `
    <div style="background-color: #f0f4fa; border-left: 4px solid #004085; padding: 12px 15px; margin: 15px 0; border-radius: 4px;">
        <strong style="color: #004085;">${title}</strong>
        <p style="margin: 8px 0 0 0;">${formatNote(note)}</p>
    </div>`;

/**
 * Builds a notification email.
 * @param {'submitted'|'resubmitted'|'needsInfo'|'statusUpdate'} type
 * @param {string} lang  user's preferred language (falls back to Hungarian)
 * @param {{ name: string, status?: string, note?: string, linkUrl?: string }} data
 * @returns {{ subject: string, html: string } | null}  null when there is nothing to send
 */
const buildEmail = (type, lang, data) => {
    const language = normalizeLanguage(lang);
    const t = templates[language] || templates[DEFAULT_LANGUAGE];
    const template = t[type];
    if (!template) return null;

    const words = common[language];
    const hasNote = data.note && String(data.note).trim() !== '';
    let content = '';

    if (type === 'statusUpdate') {
        const label = (statusLabels[language] || statusLabels[DEFAULT_LANGUAGE])[data.status];
        if (!label) return null; // unknown status: add its label above to start sending it
        content += template.body({ label });
        if (hasNote) content += noteBlock(words.noteTitle, data.note);
        if (data.status === 'rejected') content += template.rejectedExtra;
    } else {
        content += template.body();
        if (type === 'needsInfo' && hasNote) content += noteBlock(words.noteTitle, data.note);
        if (template.after) content += template.after();
    }

    const dashboardUrl = data.linkUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`;

    const html = `
        <div style="font-family: Arial, sans-serif; color: #222; max-width: 600px;">
            <h2 style="color: #004085;">${escapeHtml(words.signature)}</h2>
            <p>${escapeHtml(words.greeting(data.name || ''))}</p>
            ${content}
            <a href="${dashboardUrl}" style="background-color: #004085; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">${words.button}</a>
            <p style="color: #666; font-size: 12px; margin-top: 8px;">${words.linkNote}</p>
            <p style="color: #666; font-size: 12px; margin-top: 25px;">${escapeHtml(words.signature)}</p>
        </div>`;

    return { subject: template.subject, html };
};

module.exports = { buildEmail, normalizeLanguage, escapeHtml, statusLabels, templates };
