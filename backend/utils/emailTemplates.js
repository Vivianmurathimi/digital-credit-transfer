// Email templates for student notifications, in HU / EN / DE.
// Kept in the backend (not shared with the frontend locale files) so the two projects stay separate.

const { FRONTEND_URL } = require('../config/urls');

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

// "2 November 2026, 23:59" in the student's language, always Budapest time (the job sends
// these emails from the server, whatever time zone it runs in)
const DATE_LOCALES = { hu: 'hu-HU', en: 'en-GB', de: 'de-DE' };
const formatDeadline = (date, language) => new Intl.DateTimeFormat(DATE_LOCALES[language], {
    timeZone: 'Europe/Budapest', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(date));

// A calendar day ('YYYY-MM-DD', e.g. a semester's last day) as "31 January 2027" in the language
const formatDay = (day, language) => new Intl.DateTimeFormat(DATE_LOCALES[language], {
    timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric',
}).format(new Date(`${day}T00:00:00Z`));

// Reviewer's message exactly as written: escaped, with line breaks kept
const formatNote = (note) => escapeHtml(note).replace(/\r?\n/g, '<br>');

// Same labels the student sees in My Status (student_status_* keys in the frontend locales)
const statusLabels = {
    hu: { pending: 'Elbírálás alatt', needs_info: 'Kiegészítés szükséges', approved: 'Elfogadva', rejected: 'Elutasítva', withdrawn: 'Visszavonva' },
    en: { pending: 'Under review', needs_info: 'Information needed', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn' },
    de: { pending: 'In Prüfung', needs_info: 'Informationen benötigt', approved: 'Genehmigt', rejected: 'Abgelehnt', withdrawn: 'Zurückgezogen' },
};

// Reasons of automatic decisions (stored as codes, see jobs/applicationJobs.js), in the student's language
const reasons = {
    hu: { NO_INFO_RESPONSE: 'Nem érkezett válasz az információkérésre.', SEMESTER_ENDED: 'A kérelmet a félév lezárásáig nem bírálták el.' },
    en: { NO_INFO_RESPONSE: 'No response to information request.', SEMESTER_ENDED: 'Not reviewed before the semester closed.' },
    de: { NO_INFO_RESPONSE: 'Keine Antwort auf die Informationsanfrage.', SEMESTER_ENDED: 'Bis zum Semesterende nicht geprüft.' },
};

// Words shared by every template in a language
// The PTE final grades (reviewer Group 6): always with the Hungarian name, translated next to it
const gradeNames = {
    hu: { 5: 'jeles', 4: 'jó', 3: 'közepes', 2: 'elégséges' },
    en: { 5: 'excellent', 4: 'good', 3: 'satisfactory', 2: 'pass' },
    de: { 5: 'sehr gut', 4: 'gut', 3: 'befriedigend', 2: 'ausreichend' },
};
// "4 (jó)" in Hungarian, "4 (jó – good)" in English and German
const gradeLabel = (grade, language) => {
    const hu = gradeNames.hu[grade];
    if (!hu) return String(grade);
    const local = (gradeNames[language] || {})[grade];
    return language === 'hu' || !local ? `${grade} (${hu})` : `${grade} (${hu} – ${local})`;
};

const common = {
    hu: { greeting: (name) => `Kedves ${name}!`, button: 'Irányítópult megnyitása', linkNote: 'Biztonsági okokból ez a link 10 percig érvényes. Ezután jelentkezzen be a szokásos módon.', noteTitle: 'A bíráló üzenete:', reasonTitle: 'Indoklás:', gradeTitle: 'Végső jegy:', signature: 'PTE Kreditátvitel' },
    en: { greeting: (name) => `Dear ${name},`, button: 'Open my dashboard', linkNote: 'For your security, this link is valid for 10 minutes. After that, please log in as usual.', noteTitle: "Reviewer's message:", reasonTitle: 'Reason:', gradeTitle: 'Final grade:', signature: 'PTE Credit Transfer' },
    de: { greeting: (name) => `Liebe/r ${name},`, button: 'Mein Dashboard öffnen', linkNote: 'Aus Sicherheitsgründen ist dieser Link 10 Minuten gültig. Danach melden Sie sich bitte wie gewohnt an.', noteTitle: 'Nachricht des Gutachters:', reasonTitle: 'Begründung:', gradeTitle: 'Endnote:', signature: 'PTE Kreditübertragung' },
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
            deadline: (date) => `<p>Kérjük, válaszoljon eddig: <strong>${date}</strong> (budapesti idő szerint). Ha addig nem érkezik válasz, a kérelmet a rendszer automatikusan elutasítja.</p>`,
            after: () => `<p>Kérjük, jelentkezzen be, nyissa meg az <strong>Állapotom</strong> fület, és kattintson a <strong>Hiányzó információ hozzáadása</strong> gombra a válaszadáshoz és a dokumentumok feltöltéséhez.</p>`,
        },
        reminder: {
            subject: 'Emlékeztető: holnapig válaszoljon a kérelmével kapcsolatban',
            body: () => `<p>A bíráló még mindig várja a kreditátviteli kérelméhez kért további információkat.</p>`,
            deadline: (date) => `<p>Kérjük, válaszoljon eddig: <strong>${date}</strong> (budapesti idő szerint). Ha addig nem érkezik válasz, a kérelmet a rendszer automatikusan elutasítja.</p>`,
            after: () => `<p>Kérjük, jelentkezzen be, nyissa meg az <strong>Állapotom</strong> fület, és kattintson a <strong>Hiányzó információ hozzáadása</strong> gombra.</p>`,
        },
        withdrawn: {
            subject: 'Kreditátviteli kérelmét visszavonta',
            body: () => `<p>Kreditátviteli kérelmét visszavonta. A bíráló már nem foglalkozik vele.</p>
                <p>Ugyanarra a PTE-kurzusra bármikor beadhat új kérelmet. Ha nem Ön vonta vissza, kérjük, forduljon a Tanulmányi Osztályhoz.</p>`,
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
            deadline: (date) => `<p>Please reply by <strong>${date}</strong> (Budapest time). If there is no reply by then, the application is rejected automatically.</p>`,
            after: () => `<p>Please log in, open the <strong>My Status</strong> tab and click <strong>Add Missing Info</strong> to reply and upload documents.</p>`,
        },
        reminder: {
            subject: 'Reminder: please reply about your application by tomorrow',
            body: () => `<p>The reviewer is still waiting for the additional information for your credit transfer application.</p>`,
            deadline: (date) => `<p>Please reply by <strong>${date}</strong> (Budapest time). If there is no reply by then, the application is rejected automatically.</p>`,
            after: () => `<p>Please log in, open the <strong>My Status</strong> tab and click <strong>Add Missing Info</strong>.</p>`,
        },
        withdrawn: {
            subject: 'You withdrew your credit transfer application',
            body: () => `<p>You withdrew your credit transfer application. The reviewer will no longer work on it.</p>
                <p>You can submit a new request for the same PTE course at any time. If you did not withdraw it, please contact the Student Office.</p>`,
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
            body: () => `<p>Der Gutachter benötigt weitere Informationen, bevor über Ihren Antrag auf Kreditübertragung entschieden werden kann.</p>`,
            deadline: (date) => `<p>Bitte antworten Sie bis <strong>${date}</strong> (Budapester Zeit). Geht bis dahin keine Antwort ein, wird der Antrag automatisch abgelehnt.</p>`,
            after: () => `<p>Bitte melden Sie sich an, öffnen Sie den Reiter <strong>Mein Status</strong> und klicken Sie auf <strong>Fehlende Informationen hinzufügen</strong>, um zu antworten und Dokumente hochzuladen.</p>`,
        },
        reminder: {
            subject: 'Erinnerung: Bitte antworten Sie bis morgen zu Ihrem Antrag',
            body: () => `<p>Der Gutachter wartet noch auf die zusätzlichen Informationen zu Ihrem Antrag auf Kreditübertragung.</p>`,
            deadline: (date) => `<p>Bitte antworten Sie bis <strong>${date}</strong> (Budapester Zeit). Geht bis dahin keine Antwort ein, wird der Antrag automatisch abgelehnt.</p>`,
            after: () => `<p>Bitte melden Sie sich an, öffnen Sie den Reiter <strong>Mein Status</strong> und klicken Sie auf <strong>Fehlende Informationen hinzufügen</strong>.</p>`,
        },
        withdrawn: {
            subject: 'Sie haben Ihren Antrag auf Kreditübertragung zurückgezogen',
            body: () => `<p>Sie haben Ihren Antrag auf Kreditübertragung zurückgezogen. Der Gutachter bearbeitet ihn nicht mehr.</p>
                <p>Für denselben PTE-Kurs können Sie jederzeit einen neuen Antrag stellen. Falls Sie ihn nicht zurückgezogen haben, wenden Sie sich bitte an das Studierendensekretariat.</p>`,
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
 * @param {'submitted'|'resubmitted'|'needsInfo'|'reminder'|'withdrawn'|'statusUpdate'} type
 * @param {string} lang  user's preferred language (falls back to Hungarian)
 * @param {{ name: string, status?: string, note?: string, reasonCode?: string, finalGrade?: number, deadline?: Date|string, linkUrl?: string }} data
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
        // An approval carries its final grade (reviewer Group 6)
        if (data.status === 'approved' && data.finalGrade) content += noteBlock(words.gradeTitle, gradeLabel(data.finalGrade, language));
        // An automatic decision shows its reason in the student's language instead of a reviewer's message;
        // a rejection's rationale is shown as the reason, an approval's note as the reviewer's message
        const reason = data.reasonCode && (reasons[language] || {})[data.reasonCode];
        if (reason) content += noteBlock(words.reasonTitle, reason);
        else if (hasNote) content += noteBlock(data.status === 'rejected' ? words.reasonTitle : words.noteTitle, data.note);
        if (data.status === 'rejected') content += template.rejectedExtra;
    } else {
        content += template.body();
        if (type === 'needsInfo' && hasNote) content += noteBlock(words.noteTitle, data.note);
        // (needsInfo and reminder carry the reply deadline)
        if (template.deadline && data.deadline) content += template.deadline(escapeHtml(formatDeadline(data.deadline, language)));
        if (template.after) content += template.after();
    }

    const dashboardUrl = data.linkUrl || `${FRONTEND_URL}/login`;

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

// Account emails (Group 10): the verification link after registering and the password reset link.
// Sent in the language chosen when registering / the account's saved language.
// reviewerInvite (reviewer Group 2): the superadmin's invitation, in the language chosen for it.
const accountTemplates = {
    hu: {
        verifyAccount: {
            subject: 'Teendő: erősítse meg PTE-fiókját',
            heading: 'Üdvözöljük a PTE Kreditátviteli rendszerében!',
            text: 'Kérjük, kattintson az alábbi gombra egyetemi e-mail-címe megerősítéséhez és fiókja aktiválásához.',
            button: 'Fiók megerősítése',
            footer: 'Ha a gomb nem működik, másolja be ezt a linket a böngészőjébe:',
        },
        resetPassword: {
            subject: 'PTE Kreditátvitel: jelszó visszaállítása',
            heading: 'Jelszó-visszaállítási kérelem',
            text: 'Jelszó-visszaállítást kért PTE Kreditátviteli fiókjához. Új jelszó beállításához kattintson az alábbi gombra. A link 1 óráig érvényes.',
            button: 'Jelszó visszaállítása',
            footer: 'Ha nem Ön kérte, hagyja figyelmen kívül ezt az e-mailt.',
        },
        reviewerInvite: {
            subject: 'Meghívó bírálónak – PTE Kreditátvitel',
            heading: 'Meghívó a PTE Kreditátviteli rendszerébe',
            text: (programme) => `Meghívást kapott a(z) ${programme} szak bírálójának. Az alábbi gombra kattintva állítsa be jelszavát és aktiválja fiókját.`,
            button: 'Meghívó elfogadása',
            footer: 'A link 7 napig érvényes, és csak egyszer használható. Ha a gomb nem működik, másolja be ezt a linket a böngészőjébe:',
        },
    },
    en: {
        verifyAccount: {
            subject: 'Action required: verify your PTE account',
            heading: 'Welcome to the PTE Credit Transfer System!',
            text: 'Please click the button below to verify your university email address and activate your account.',
            button: 'Verify my account',
            footer: "If the button doesn't work, copy this link into your browser:",
        },
        resetPassword: {
            subject: 'PTE Credit Transfer: password reset',
            heading: 'Password reset request',
            text: 'You asked to reset the password of your PTE Credit Transfer account. Click the button below to set a new password. This link is valid for 1 hour.',
            button: 'Reset password',
            footer: 'If you did not ask for this, you can ignore this email.',
        },
        reviewerInvite: {
            subject: 'Reviewer invitation – PTE Credit Transfer',
            heading: 'Invitation to the PTE Credit Transfer System',
            text: (programme) => `You have been invited to be the reviewer for the ${programme} programme. Click the button below to set your password and activate your account.`,
            button: 'Accept invitation',
            footer: "This link is valid for 7 days and can be used once. If the button doesn't work, copy this link into your browser:",
        },
    },
    de: {
        verifyAccount: {
            subject: 'Handlungsbedarf: Bestätigen Sie Ihr PTE-Konto',
            heading: 'Willkommen im PTE-Kreditübertragungssystem!',
            text: 'Bitte klicken Sie auf die Schaltfläche unten, um Ihre Universitäts-E-Mail-Adresse zu bestätigen und Ihr Konto zu aktivieren.',
            button: 'Konto bestätigen',
            footer: 'Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:',
        },
        resetPassword: {
            subject: 'PTE-Kreditübertragung: Passwort zurücksetzen',
            heading: 'Anfrage zum Zurücksetzen des Passworts',
            text: 'Sie haben das Zurücksetzen des Passworts für Ihr PTE-Kreditübertragungskonto angefordert. Klicken Sie auf die Schaltfläche unten, um ein neues Passwort festzulegen. Dieser Link ist 1 Stunde gültig.',
            button: 'Passwort zurücksetzen',
            footer: 'Falls Sie dies nicht angefordert haben, können Sie diese E-Mail ignorieren.',
        },
        reviewerInvite: {
            subject: 'Einladung als Gutachter – PTE-Kreditübertragung',
            heading: 'Einladung zum PTE-Kreditübertragungssystem',
            text: (programme) => `Sie wurden als Gutachter für den Studiengang ${programme} eingeladen. Klicken Sie auf die Schaltfläche unten, um Ihr Passwort festzulegen und Ihr Konto zu aktivieren.`,
            button: 'Einladung annehmen',
            footer: 'Dieser Link ist 7 Tage gültig und kann nur einmal verwendet werden. Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:',
        },
    },
};

/**
 * Builds an account email with its link button.
 * @param {'verifyAccount'|'resetPassword'|'reviewerInvite'} type
 * @param {string} lang  falls back to Hungarian
 * @param {{ url: string, programme?: string }} data  programme: the programme's name (reviewer invite)
 * @returns {{ subject: string, html: string }}
 */
const buildAccountEmail = (type, lang, { url, programme = '' }) => {
    const language = normalizeLanguage(lang);
    const words = accountTemplates[language][type];
    const link = escapeHtml(url);
    const color = type === 'resetPassword' ? '#dc3545' : '#004085';
    const text = typeof words.text === 'function' ? words.text(programme) : words.text;
    // The verification and invite emails show the link as text too; the reset email says what to do if unrequested
    const footer = type === 'resetPassword'
        ? `<p>${escapeHtml(words.footer)}</p>`
        : `<p>${escapeHtml(words.footer)}<br/>${link}</p>`;
    const html = `
        <div style="font-family: Arial, sans-serif; color: #222; max-width: 600px;">
            <h2>${escapeHtml(words.heading)}</h2>
            <p>${escapeHtml(text)}</p>
            <a href="${link}" style="background-color: ${color}; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">${escapeHtml(words.button)}</a>
            ${footer}
        </div>`;
    return { subject: words.subject, html };
};

// The programme and the two numbers of a semester-end reminder, as a list (no plural forms needed)
const reminderCounts = (language, { programme, pending, needsInfo }) => {
    const words = reviewerTemplates[language].counts;
    return `<p>${words.programme}: <strong>${programme}</strong></p><ul><li>${words.pending}: <strong>${pending}</strong></li><li>${words.needsInfo}: <strong>${needsInfo}</strong></li></ul>`;
};

// Emails to the programme's reviewer (reviewer Group 6): a new application, and a student's reply
// to a request for information. In the reviewer's saved language; the button opens the login page.
const reviewerTemplates = {
    hu: {
        greeting: (name) => `Kedves ${name}!`,
        button: 'Bejelentkezés',
        signature: 'PTE Kreditátvitel',
        newApplication: {
            subject: 'Új kreditátviteli kérelem érkezett',
            body: ({ student, course }) => `<p>Új kérelem érkezett a szakjára: <strong>${student}</strong>, ${course}.</p><p>A kérelem az Elbírálásra vár fülön található.</p>`,
        },
        studentReplied: {
            subject: 'Egy hallgató válaszolt a kiegészítési kérésére',
            body: ({ student, course }) => `<p><strong>${student}</strong> válaszolt a kiegészítési kérésére: ${course}.</p><p>A kérelem ismét az Elbírálásra vár fülön található.</p>`,
        },
        // Before the semester ends (reviewer Group 7): 7 days before, and on the last day
        semesterEndsSoon: {
            subject: 'Hamarosan véget ér a félév: kérelmek várnak az elbírálására',
            body: (data) => `<p>A félév utolsó napja: <strong>${data.date}</strong>.</p>${reminderCounts('hu', data)}<p>A félév végéig el nem bírált kérelmeket a rendszer automatikusan elutasítja.</p>`,
        },
        semesterEndsToday: {
            subject: 'Ma van a félév utolsó napja: kérelmek várnak az elbírálására',
            body: (data) => `<p>Ma van a félév utolsó napja (<strong>${data.date}</strong>).</p>${reminderCounts('hu', data)}<p>Az éjfélig el nem bírált kérelmeket a rendszer automatikusan elutasítja.</p>`,
        },
        counts: { programme: 'Szak', pending: 'Elbírálásra vár', needsInfo: 'A hallgató válaszára vár' },
    },
    en: {
        greeting: (name) => `Dear ${name},`,
        button: 'Log in',
        signature: 'PTE Credit Transfer',
        newApplication: {
            subject: 'New credit transfer application',
            body: ({ student, course }) => `<p>A new application has arrived in your programme: <strong>${student}</strong>, ${course}.</p><p>You will find it under Pending.</p>`,
        },
        studentReplied: {
            subject: 'A student replied to your request for information',
            body: ({ student, course }) => `<p><strong>${student}</strong> replied to your request for information: ${course}.</p><p>The application is back under Pending.</p>`,
        },        semesterEndsSoon: {
            subject: 'The semester ends soon: applications are waiting for your decision',
            body: (data) => `<p>The last day of the semester is <strong>${data.date}</strong>.</p>${reminderCounts('en', data)}<p>Applications not decided by the end of the semester are rejected automatically.</p>`,
        },
        semesterEndsToday: {
            subject: 'Today is the last day of the semester: applications are waiting for your decision',
            body: (data) => `<p>Today (<strong>${data.date}</strong>) is the last day of the semester.</p>${reminderCounts('en', data)}<p>Applications not decided by midnight are rejected automatically.</p>`,
        },
        counts: { programme: 'Programme', pending: 'Waiting for your decision', needsInfo: "Waiting for the student's reply" },
    },
    de: {
        greeting: (name) => `Liebe/r ${name},`,
        button: 'Anmelden',
        signature: 'PTE-Kreditübertragung',
        newApplication: {
            subject: 'Neuer Antrag auf Kreditübertragung',
            body: ({ student, course }) => `<p>In Ihrem Studiengang ist ein neuer Antrag eingegangen: <strong>${student}</strong>, ${course}.</p><p>Sie finden ihn unter „Ausstehend“.</p>`,
        },
        studentReplied: {
            subject: 'Ein Studierender hat auf Ihre Informationsanfrage geantwortet',
            body: ({ student, course }) => `<p><strong>${student}</strong> hat auf Ihre Informationsanfrage geantwortet: ${course}.</p><p>Der Antrag steht wieder unter „Ausstehend“.</p>`,
        },        semesterEndsSoon: {
            subject: 'Das Semester endet bald: Anträge warten auf Ihre Entscheidung',
            body: (data) => `<p>Der letzte Tag des Semesters ist der <strong>${data.date}</strong>.</p>${reminderCounts('de', data)}<p>Anträge, die bis zum Semesterende nicht entschieden sind, werden automatisch abgelehnt.</p>`,
        },
        semesterEndsToday: {
            subject: 'Heute ist der letzte Tag des Semesters: Anträge warten auf Ihre Entscheidung',
            body: (data) => `<p>Heute (<strong>${data.date}</strong>) ist der letzte Tag des Semesters.</p>${reminderCounts('de', data)}<p>Anträge, die bis Mitternacht nicht entschieden sind, werden automatisch abgelehnt.</p>`,
        },
        counts: { programme: 'Studiengang', pending: 'Warten auf Ihre Entscheidung', needsInfo: 'Warten auf die Antwort der Studierenden' },
    },
};

/**
 * An email to a reviewer.
 * @param {'newApplication'|'studentReplied'|'semesterEndsSoon'|'semesterEndsToday'} type
 * @param {{ name: string, student?: string, course?: string, programme?: string, endsOn?: string, pending?: number, needsInfo?: number }} data
 *   every text is escaped here; endsOn ('YYYY-MM-DD', the semester's last day) is written as a date in the language
 */
const buildReviewerEmail = (type, lang, { name, student = '', course = '', programme = '', endsOn = null, pending = 0, needsInfo = 0 }) => {
    const language = normalizeLanguage(lang);
    const words = reviewerTemplates[language];
    const template = typeof words[type]?.body === 'function' ? words[type] : null;
    if (!template) return null;
    const body = template.body({
        student: escapeHtml(student), course: escapeHtml(course), programme: escapeHtml(programme),
        date: endsOn ? escapeHtml(formatDay(endsOn, language)) : '', pending: Number(pending) || 0, needsInfo: Number(needsInfo) || 0,
    });
    const html = `
        <div style="font-family: Arial, sans-serif; color: #222; max-width: 600px;">
            <h2 style="color: #004085;">${escapeHtml(words.signature)}</h2>
            <p>${escapeHtml(words.greeting(name || ''))}</p>
            ${body}
            <a href="${escapeHtml(`${FRONTEND_URL}/login`)}" style="background-color: #004085; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">${escapeHtml(words.button)}</a>
            <p style="color: #666; font-size: 12px; margin-top: 25px;">${escapeHtml(words.signature)}</p>
        </div>`;
    return { subject: template.subject, html };
};

// Every text table by language, for the translation check (frontend: npm run check:translations)
const translatedTables = { templates, statusLabels, reasons, common, accountTemplates, gradeNames, reviewerTemplates };

module.exports = { buildEmail, buildAccountEmail, buildReviewerEmail, gradeLabel, normalizeLanguage, escapeHtml, statusLabels, templates, reasons, translatedTables };
