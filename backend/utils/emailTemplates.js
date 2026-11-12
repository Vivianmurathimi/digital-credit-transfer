// Email templates for student notifications, in HU / EN / DE.
// Kept in the backend (not shared with the frontend locale files) so the two projects stay separate.

const { FRONTEND_URL } = require('../config/urls');
const { BRAND_COLORS: C } = require('./brandColors');

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
    hu: { pending: 'Elbírálás alatt', needs_info: 'Kiegészítés szükséges', awaiting_committee: 'Bizottsági elbírálás alatt', approved: 'Elfogadva', rejected: 'Elutasítva', withdrawn: 'Visszavonva' },
    en: { pending: 'Under review', needs_info: 'Information needed', awaiting_committee: 'Under committee review', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn' },
    de: { pending: 'In Prüfung', needs_info: 'Informationen benötigt', awaiting_committee: 'Prüfung durch den Ausschuss', approved: 'Genehmigt', rejected: 'Abgelehnt', withdrawn: 'Zurückgezogen' },
};

// Reasons stored as codes (automatic decisions, jobs/applicationJobs.js; PROGRAMME_CHANGED: withdrawn
// when the admin changed the student's programme, admin round Group 3), in the student's language
const reasons = {
    hu: { NO_INFO_RESPONSE: 'Nem érkezett válasz az információkérésre.', SEMESTER_ENDED: 'A kérelmet a félév lezárásáig nem bírálták el.', PROGRAMME_CHANGED: 'A szakot az adminisztrátor megváltoztatta.' },
    en: { NO_INFO_RESPONSE: 'No response to information request.', SEMESTER_ENDED: 'Not reviewed before the semester closed.', PROGRAMME_CHANGED: 'Programme changed by the administrator.' },
    de: { NO_INFO_RESPONSE: 'Keine Antwort auf die Informationsanfrage.', SEMESTER_ENDED: 'Bis zum Semesterende nicht geprüft.', PROGRAMME_CHANGED: 'Studiengang vom Administrator geändert.' },
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
        draftReminder: {
            subject: 'Be nem küldött kérelemtervezet – PTE Kreditátvitel',
            body: () => `<p>Van egy kérelemtervezete, amelyet még nem küldött be.</p>`,
            deadline: (date) => `<p>A jelentkezés lezárul: <strong>${date}</strong> (budapesti idő szerint). A be nem küldött tervezetek a félév lezárásakor törlődnek.</p>`,
            after: () => `<p>Kérjük, jelentkezzen be, és küldje be kérelmét a határidő előtt.</p>`,
        },
        withdrawn: {
            subject: 'Kreditátviteli kérelmét visszavonta',
            body: () => `<p>Kreditátviteli kérelmét visszavonta. A bíráló már nem foglalkozik vele.</p>
                <p>Ugyanarra a PTE-kurzusra bármikor beadhat új kérelmet. Ha nem Ön vonta vissza, kérjük, forduljon a Tanulmányi Osztályhoz.</p>`,
        },
        programmeChanged: {
            subject: 'Megváltozott a szakja – PTE Kreditátvitel',
            body: ({ from, to }) => `<p>Az adminisztrátor megváltoztatta a szakját: <strong>${from}</strong> helyett mostantól <strong>${to}</strong>.</p>`,
            withdrawnIntro: 'Ezeket a kérelmeit visszavontuk (indoklás: a szakot az adminisztrátor megváltoztatta):',
            noneWithdrawn: '<p>Egyetlen kérelmét sem kellett visszavonni.</p>',
            draftRemoved: '<p>Be nem küldött kérelemtervezetét töröltük, mert a kurzusai a korábbi szakjához tartoztak.</p>',
            after: '<p>Az új szakján bármikor beadhat új kérelmet.</p>',
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
        draftReminder: {
            subject: 'Your draft has not been submitted – PTE Credit Transfer',
            body: () => `<p>You have an application draft that has not been submitted yet.</p>`,
            deadline: (date) => `<p>Applications close on <strong>${date}</strong> (Budapest time). Unsent drafts are deleted when the semester is closed.</p>`,
            after: () => `<p>Please log in and submit your application before then.</p>`,
        },
        withdrawn: {
            subject: 'You withdrew your credit transfer application',
            body: () => `<p>You withdrew your credit transfer application. The reviewer will no longer work on it.</p>
                <p>You can submit a new request for the same PTE course at any time. If you did not withdraw it, please contact the Student Office.</p>`,
        },
        programmeChanged: {
            subject: 'Your study programme has changed – PTE Credit Transfer',
            body: ({ from, to }) => `<p>The administrator changed your study programme from <strong>${from}</strong> to <strong>${to}</strong>.</p>`,
            withdrawnIntro: 'These applications were withdrawn (reason: programme changed by the administrator):',
            noneWithdrawn: '<p>None of your applications had to be withdrawn.</p>',
            draftRemoved: '<p>Your unsent application draft was removed, because its courses belonged to your old programme.</p>',
            after: '<p>You can submit new applications under your new programme at any time.</p>',
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
        draftReminder: {
            subject: 'Ihr Entwurf wurde noch nicht gesendet – PTE-Kreditübertragung',
            body: () => `<p>Sie haben einen Antragsentwurf, der noch nicht gesendet wurde.</p>`,
            deadline: (date) => `<p>Anträge sind bis <strong>${date}</strong> (Budapester Zeit) möglich. Nicht gesendete Entwürfe werden beim Abschluss des Semesters gelöscht.</p>`,
            after: () => `<p>Bitte melden Sie sich an und senden Sie Ihren Antrag vorher ab.</p>`,
        },
        withdrawn: {
            subject: 'Sie haben Ihren Antrag auf Kreditübertragung zurückgezogen',
            body: () => `<p>Sie haben Ihren Antrag auf Kreditübertragung zurückgezogen. Der Gutachter bearbeitet ihn nicht mehr.</p>
                <p>Für denselben PTE-Kurs können Sie jederzeit einen neuen Antrag stellen. Falls Sie ihn nicht zurückgezogen haben, wenden Sie sich bitte an das Studierendensekretariat.</p>`,
        },
        programmeChanged: {
            subject: 'Ihr Studiengang wurde geändert – PTE-Kreditübertragung',
            body: ({ from, to }) => `<p>Der Administrator hat Ihren Studiengang von <strong>${from}</strong> auf <strong>${to}</strong> geändert.</p>`,
            withdrawnIntro: 'Diese Anträge wurden zurückgezogen (Begründung: Studiengang vom Administrator geändert):',
            noneWithdrawn: '<p>Keiner Ihrer Anträge musste zurückgezogen werden.</p>',
            draftRemoved: '<p>Ihr nicht gesendeter Antragsentwurf wurde gelöscht, da seine Kurse zu Ihrem bisherigen Studiengang gehörten.</p>',
            after: '<p>Unter Ihrem neuen Studiengang können Sie jederzeit neue Anträge stellen.</p>',
        },
        statusUpdate: {
            subject: 'Neuigkeiten zu Ihrem Antrag auf Kreditübertragung',
            body: ({ label }) => `<p>Der Status Ihres Antrags auf Kreditübertragung wurde geändert auf: <strong>${label}</strong>.</p>`,
            rejectedExtra: '<p>Bei Fragen zu dieser Entscheidung wenden Sie sich bitte an das Studierendensekretariat.</p>',
        },
    },
};

const noteBlock = (title, note) => `
    <div style="background-color: ${C.panel}; border-left: 4px solid ${C.panelBorder}; padding: 12px 15px; margin: 15px 0; border-radius: 4px;">
        <strong style="color: ${C.brand};">${title}</strong>
        <p style="margin: 8px 0 0 0;">${formatNote(note)}</p>
    </div>`;

/**
 * Builds a notification email.
 * @param {'submitted'|'resubmitted'|'needsInfo'|'reminder'|'withdrawn'|'statusUpdate'|'programmeChanged'|'draftReminder'} type
 * @param {string} lang  user's preferred language (falls back to Hungarian)
 * programmeChanged also takes { fromProgramme, toProgramme, withdrawn: ['CODE – Name'], draftRemoved }
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

    if (type === 'programmeChanged') {
        // The old and new programme (names in the student's language), the withdrawn applications,
        // whether the unsent draft was removed, and that they can apply again (admin round Group 3)
        const nameIn = (programme) => escapeHtml(programme ? programme[`name_${language}`] || programme.name_en || programme.code || '' : '—');
        content += template.body({ from: nameIn(data.fromProgramme), to: nameIn(data.toProgramme) });
        const courses = Array.isArray(data.withdrawn) ? data.withdrawn : [];
        content += courses.length > 0
            ? `<p>${escapeHtml(template.withdrawnIntro)}</p><ul>${courses.map((course) => `<li>${escapeHtml(course)}</li>`).join('')}</ul>`
            : template.noneWithdrawn;
        if (data.draftRemoved) content += template.draftRemoved;
        content += template.after;
    } else if (type === 'statusUpdate') {
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
        <div style="font-family: Arial, sans-serif; color: ${C.textStrong}; max-width: 600px;">
            <h2 style="color: ${C.brand};">${escapeHtml(words.signature)}</h2>
            <p>${escapeHtml(words.greeting(data.name || ''))}</p>
            ${content}
            <a href="${dashboardUrl}" style="background-color: ${C.brand}; color: ${C.textOnPrimary}; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">${words.button}</a>
            <p style="color: ${C.textMuted}; font-size: 12px; margin-top: 8px;">${words.linkNote}</p>
            <p style="color: ${C.textMuted}; font-size: 12px; margin-top: 25px;">${escapeHtml(words.signature)}</p>
        </div>`;

    return { subject: template.subject, html };
};

// Account emails (Group 10): the verification link after registering and the password reset link.
// Sent in the language chosen when registering / the account's saved language.
// reviewerInvite (reviewer Group 2) and adminInvite (admin round Group 2): the superadmin's
// invitation, in the language chosen for it.
// A reviewer's role in a programme (round 2 Group 1), e.g. in the invite: "Civil Engineering (extra reviewer)"
const staffRoleLabels = {
    hu: { main: 'fő bíráló', extra: 'további bíráló', committee: 'bizottsági tag' },
    en: { main: 'main reviewer', extra: 'extra reviewer', committee: 'committee member' },
    de: { main: 'Hauptgutachter', extra: 'zusätzlicher Gutachter', committee: 'Ausschussmitglied' },
};

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
            text: (programme) => `Meghívást kapott bírálónak: ${programme}. Az alábbi gombra kattintva állítsa be jelszavát és aktiválja fiókját.`,
            button: 'Meghívó elfogadása',
            footer: 'A link 7 napig érvényes, és csak egyszer használható. Ha a gomb nem működik, másolja be ezt a linket a böngészőjébe:',
        },
        lateAccess: {
            subject: 'Késői hozzáférés – PTE Kreditátvitel',
            heading: 'Késői hozzáférést kapott',
            text: (_, deadline) => `Az adminisztrátor késői hozzáférést adott Önnek: ${deadline}-ig (budapesti idő) regisztrálhat és beadhatja kreditátviteli kérelmét, akkor is, ha a jelentkezési időszak lezárult.`,
            button: 'Tovább a rendszerbe',
            footer: 'Ha a gomb nem működik, másolja be ezt a linket a böngészőjébe:',
        },
        // Round 2 Group 2: someone only on committees, for the programmes listed
        committeeInvite: {
            subject: 'Meghívó a bizottságba – PTE Kreditátvitel',
            heading: 'Meghívó a PTE Kreditátviteli rendszerébe',
            text: (programme) => `Meghívást kapott a bizottságba: ${programme}. A bizottság megerősíti vagy módosítja a bírálók döntéseit. Az alábbi gombra kattintva állítsa be jelszavát és aktiválja fiókját.`,
            button: 'Meghívó elfogadása',
            footer: 'A link 7 napig érvényes, és csak egyszer használható. Ha a gomb nem működik, másolja be ezt a linket a böngészőjébe:',
        },
        adminInvite: {
            subject: 'Meghívó adminisztrátornak – PTE Kreditátvitel',
            heading: 'Meghívó a PTE Kreditátviteli rendszerébe',
            text: 'Meghívást kapott a PTE Kreditátviteli rendszer adminisztrátorának. Az alábbi gombra kattintva állítsa be jelszavát és aktiválja fiókját.',
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
            text: (programme) => `You have been invited as a reviewer for: ${programme}. Click the button below to set your password and activate your account.`,
            button: 'Accept invitation',
            footer: "This link is valid for 7 days and can be used once. If the button doesn't work, copy this link into your browser:",
        },
        lateAccess: {
            subject: 'Late access – PTE Credit Transfer',
            heading: 'You have been given late access',
            text: (_, deadline) => `The administrator has given you late access: you can register and submit your credit transfer application until ${deadline} (Budapest time), even though the application period is closed.`,
            button: 'Go to the application system',
            footer: "If the button doesn't work, copy this link into your browser:",
        },
        committeeInvite: {
            subject: 'Committee invitation – PTE Credit Transfer',
            heading: 'Invitation to the PTE Credit Transfer System',
            text: (programme) => `You have been invited to the committee for: ${programme}. The committee confirms or changes the reviewers' decisions. Click the button below to set your password and activate your account.`,
            button: 'Accept invitation',
            footer: "This link is valid for 7 days and can be used once. If the button doesn't work, copy this link into your browser:",
        },
        adminInvite: {
            subject: 'Administrator invitation – PTE Credit Transfer',
            heading: 'Invitation to the PTE Credit Transfer System',
            text: 'You have been invited to be an administrator of the PTE Credit Transfer System. Click the button below to set your password and activate your account.',
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
            text: (programme) => `Sie wurden als Gutachter eingeladen für: ${programme}. Klicken Sie auf die Schaltfläche unten, um Ihr Passwort festzulegen und Ihr Konto zu aktivieren.`,
            button: 'Einladung annehmen',
            footer: 'Dieser Link ist 7 Tage gültig und kann nur einmal verwendet werden. Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:',
        },
        lateAccess: {
            subject: 'Später Zugang – PTE-Kreditübertragung',
            heading: 'Sie haben späten Zugang erhalten',
            text: (_, deadline) => `Der Administrator hat Ihnen späten Zugang gewährt: Bis ${deadline} (Budapester Zeit) können Sie sich registrieren und Ihren Antrag auf Kreditübertragung einreichen, auch wenn der Antragszeitraum geschlossen ist.`,
            button: 'Zum Antragssystem',
            footer: 'Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:',
        },
        committeeInvite: {
            subject: 'Einladung in den Ausschuss – PTE-Kreditübertragung',
            heading: 'Einladung zum PTE-Kreditübertragungssystem',
            text: (programme) => `Sie wurden in den Ausschuss eingeladen für: ${programme}. Der Ausschuss bestätigt oder ändert die Entscheidungen der Gutachter/innen. Klicken Sie auf die Schaltfläche unten, um Ihr Passwort festzulegen und Ihr Konto zu aktivieren.`,
            button: 'Einladung annehmen',
            footer: 'Dieser Link ist 7 Tage gültig und kann nur einmal verwendet werden. Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:',
        },
        adminInvite: {
            subject: 'Einladung als Administrator – PTE-Kreditübertragung',
            heading: 'Einladung zum PTE-Kreditübertragungssystem',
            text: 'Sie wurden als Administrator des PTE-Kreditübertragungssystems eingeladen. Klicken Sie auf die Schaltfläche unten, um Ihr Passwort festzulegen und Ihr Konto zu aktivieren.',
            button: 'Einladung annehmen',
            footer: 'Dieser Link ist 7 Tage gültig und kann nur einmal verwendet werden. Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:',
        },
    },
};

/**
 * Builds an account email with its link button.
 * @param {'verifyAccount'|'resetPassword'|'reviewerInvite'|'committeeInvite'|'adminInvite'|'lateAccess'} type
 * @param {string} lang  falls back to Hungarian
 * @param {{ url: string, programme?: string }} data  programme: the programme's name (reviewer invite)
 * @returns {{ subject: string, html: string }}
 */
const buildAccountEmail = (type, lang, { url, programme = '', deadline = null }) => {
    const language = normalizeLanguage(lang);
    const words = accountTemplates[language][type];
    const link = escapeHtml(url);
    const color = type === 'resetPassword' ? C.red : C.brand;
    // lateAccess (admin round Group 5) shows its deadline in Budapest time, in the language
    const text = typeof words.text === 'function' ? words.text(programme, deadline ? formatDeadline(deadline, language) : '') : words.text;
    // The verification and invite emails show the link as text too; the reset email says what to do if unrequested
    const footer = type === 'resetPassword'
        ? `<p>${escapeHtml(words.footer)}</p>`
        : `<p>${escapeHtml(words.footer)}<br/>${link}</p>`;
    const html = `
        <div style="font-family: Arial, sans-serif; color: ${C.textStrong}; max-width: 600px;">
            <h2>${escapeHtml(words.heading)}</h2>
            <p>${escapeHtml(text)}</p>
            <a href="${link}" style="background-color: ${color}; color: ${C.textOnPrimary}; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">${escapeHtml(words.button)}</a>
            ${footer}
        </div>`;
    return { subject: words.subject, html };
};

// The programme and the two numbers of a review-deadline reminder, as a list (no plural forms needed)
const reminderCounts = (language, { programme, pending, needsInfo }) => {
    const words = reviewerTemplates[language].counts;
    return `<p>${words.programme}: <strong>${programme}</strong></p><ul><li>${words.pending}: <strong>${pending}</strong></li><li>${words.needsInfo}: <strong>${needsInfo}</strong></li></ul>`;
};

// Emails to reviewers, in the reviewer's saved language; the button opens the login page. Round 2
// Group 1: no email per new application or reply any more, one daily summary instead (dailySummary),
// and the reminders before the review deadline.
const reviewerTemplates = {
    hu: {
        greeting: (name) => `Kedves ${name}!`,
        button: 'Bejelentkezés',
        signature: 'PTE Kreditátvitel',
        // The daily summary (round 2 Group 1): what is new since the last one, at 07:00 Budapest time
        dailySummary: {
            subject: 'Napi összefoglaló: új kérelmek és válaszok',
            intro: '<p>Az előző összefoglaló óta ez történt az Ön szakjain:</p>',
            newApplications: 'Új kérelmek',
            replies: 'Hallgatói válaszok a kiegészítési kérésekre',
            more: (count) => `… és még ${count}`,
            waiting: (count) => `<p>Jelenleg az Ön döntésére vár: <strong>${count}</strong>.</p>`,
        },
        // Before the review deadline (round 2 Group 1): 7 days before, and 1 day before. A target:
        // nothing is rejected when it passes
        reviewDeadlineSoon: {
            subject: 'Közeleg az elbírálási határidő: kérelmek várnak Önre',
            body: (data) => `<p>Az elbírálási határidő: <strong>${data.date}</strong>.</p>${reminderCounts('hu', data)}<p>Kérjük, addig bírálja el őket. A határidő után semmit sem utasít el a rendszer, de az adminisztrátorok értesítést kapnak.</p>`,
        },
        reviewDeadlineTomorrow: {
            subject: 'Holnap jár le az elbírálási határidő: kérelmek várnak Önre',
            body: (data) => `<p>Az elbírálási határidő holnap jár le: <strong>${data.date}</strong>.</p>${reminderCounts('hu', data)}<p>A határidő után semmit sem utasít el a rendszer, de az adminisztrátorok értesítést kapnak.</p>`,
        },
        counts: { programme: 'Szak', pending: 'Elbírálásra vár', needsInfo: 'A hallgató válaszára vár' },
    },
    en: {
        greeting: (name) => `Dear ${name},`,
        button: 'Log in',
        signature: 'PTE Credit Transfer',
        dailySummary: {
            subject: 'Daily summary: new applications and replies',
            intro: '<p>This happened in your programmes since your last summary:</p>',
            newApplications: 'New applications',
            replies: 'Student replies to requests for information',
            more: (count) => `… and ${count} more`,
            waiting: (count) => `<p>Waiting for your decision now: <strong>${count}</strong>.</p>`,
        },
        reviewDeadlineSoon: {
            subject: 'The review deadline is coming: applications are waiting for your decision',
            body: (data) => `<p>The review deadline is <strong>${data.date}</strong>.</p>${reminderCounts('en', data)}<p>Please decide them by then. Nothing is rejected when the deadline passes, but the administrators are told.</p>`,
        },
        reviewDeadlineTomorrow: {
            subject: 'The review deadline is tomorrow: applications are waiting for your decision',
            body: (data) => `<p>The review deadline is tomorrow: <strong>${data.date}</strong>.</p>${reminderCounts('en', data)}<p>Nothing is rejected when the deadline passes, but the administrators are told.</p>`,
        },
        counts: { programme: 'Programme', pending: 'Waiting for your decision', needsInfo: "Waiting for the student's reply" },
    },
    de: {
        greeting: (name) => `Liebe/r ${name},`,
        button: 'Anmelden',
        signature: 'PTE-Kreditübertragung',
        dailySummary: {
            subject: 'Tägliche Zusammenfassung: neue Anträge und Antworten',
            intro: '<p>Seit Ihrer letzten Zusammenfassung ist in Ihren Studiengängen Folgendes geschehen:</p>',
            newApplications: 'Neue Anträge',
            replies: 'Antworten von Studierenden auf Informationsanfragen',
            more: (count) => `… und ${count} weitere`,
            waiting: (count) => `<p>Jetzt warten auf Ihre Entscheidung: <strong>${count}</strong>.</p>`,
        },
        reviewDeadlineSoon: {
            subject: 'Die Prüfungsfrist rückt näher: Anträge warten auf Ihre Entscheidung',
            body: (data) => `<p>Die Prüfungsfrist ist der <strong>${data.date}</strong>.</p>${reminderCounts('de', data)}<p>Bitte entscheiden Sie bis dahin. Nach der Frist wird nichts abgelehnt, aber die Administration wird informiert.</p>`,
        },
        reviewDeadlineTomorrow: {
            subject: 'Die Prüfungsfrist endet morgen: Anträge warten auf Ihre Entscheidung',
            body: (data) => `<p>Die Prüfungsfrist endet morgen: <strong>${data.date}</strong>.</p>${reminderCounts('de', data)}<p>Nach der Frist wird nichts abgelehnt, aber die Administration wird informiert.</p>`,
        },
        counts: { programme: 'Studiengang', pending: 'Warten auf Ihre Entscheidung', needsInfo: 'Warten auf die Antwort der Studierenden' },
    },
};

/**
 * An email to a reviewer.
 * @param {'reviewDeadlineSoon'|'reviewDeadlineTomorrow'} type  (the daily summary: buildReviewerSummaryEmail)
 * @param {{ name: string, student?: string, course?: string, programme?: string, deadline?: Date|string, pending?: number, needsInfo?: number }} data
 *   every text is escaped here; deadline (the review deadline, a moment) is written in Budapest time, in the language
 */
const buildReviewerEmail = (type, lang, { name, student = '', course = '', programme = '', deadline = null, pending = 0, needsInfo = 0 }) => {
    const language = normalizeLanguage(lang);
    const words = reviewerTemplates[language];
    const template = typeof words[type]?.body === 'function' ? words[type] : null;
    if (!template) return null;
    const body = template.body({
        student: escapeHtml(student), course: escapeHtml(course), programme: escapeHtml(programme),
        date: deadline ? escapeHtml(formatDeadline(deadline, language)) : '', pending: Number(pending) || 0, needsInfo: Number(needsInfo) || 0,
    });
    const html = `
        <div style="font-family: Arial, sans-serif; color: ${C.textStrong}; max-width: 600px;">
            <h2 style="color: ${C.brand};">${escapeHtml(words.signature)}</h2>
            <p>${escapeHtml(words.greeting(name || ''))}</p>
            ${body}
            <a href="${escapeHtml(`${FRONTEND_URL}/login`)}" style="background-color: ${C.brand}; color: ${C.textOnPrimary}; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">${escapeHtml(words.button)}</a>
            <p style="color: ${C.textMuted}; font-size: 12px; margin-top: 25px;">${escapeHtml(words.signature)}</p>
        </div>`;
    return { subject: template.subject, html };
};

// Emails to the admins (round 2 Group 1)
// noMainReviewer: a programme lost its main reviewer while extra reviewers remain. Nobody is
// promoted automatically: the admin makes an extra reviewer the main one, or invites a swap.
const adminTemplates = {
    hu: {
        greeting: (name) => `Kedves ${name}!`,
        button: 'Bejelentkezés',
        signature: 'PTE Kreditátvitel',
        noMainReviewer: {
            subject: 'Egy szaknak nincs fő bírálója',
            body: ({ programme, extras }) => `<p>A(z) <strong>${programme}</strong> szaknak nincs többé fő bírálója. További bírálói: ${extras}.</p><p>A segítő további bírálók tovább dolgoznak a kérelmeken. Válasszon új fő bírálót a Bírálók menüben: tegyen meg egy további bírálót fő bírálónak, vagy hívjon meg valakit. Ha senki sem segíthet, a szak kérelmei Önre várnak.</p>`,
        },
        // The review deadline passed with undecided applications (round 2 Group 1): nothing is rejected
        reviewDeadlinePassed: {
            subject: 'Lejárt az elbírálási határidő: el nem bírált kérelmek',
            intro: ({ semester, date }) => `<p>A(z) <strong>${semester}</strong> félév elbírálási határideje lejárt (${date}). Ezek a kérelmek még nincsenek elbírálva:</p>`,
            after: '<p>A rendszer semmit sem utasított el. Meghosszabbíthatja a határidőt (Félévek), engedheti segíteni egy további bírálót (Bírálók), vagy adminisztrátorként dönthet (Kérelmek). A félév akkor zárható le, ha minden kérelem el van bírálva.</p>',
            counts: { pending: 'elbírálásra vár', needsInfo: 'a hallgató válaszára vár' },
        },
    },
    en: {
        greeting: (name) => `Dear ${name},`,
        button: 'Log in',
        signature: 'PTE Credit Transfer',
        noMainReviewer: {
            subject: 'A programme has no main reviewer',
            body: ({ programme, extras }) => `<p><strong>${programme}</strong> no longer has a main reviewer. Its extra reviewers: ${extras}.</p><p>Extra reviewers who are allowed to assist keep working on the applications. Choose a new main reviewer under Reviewers: make an extra reviewer the main one, or invite someone. If nobody is allowed to assist, the programme's applications wait for you.</p>`,
        },
        // The review deadline passed with undecided applications (round 2 Group 1): nothing is rejected
        reviewDeadlinePassed: {
            subject: 'The review deadline has passed: applications are still undecided',
            intro: ({ semester, date }) => `<p>The review deadline of <strong>${semester}</strong> has passed (${date}). These applications are still undecided:</p>`,
            after: '<p>Nothing has been rejected. You can extend the review deadline (Semesters), let an extra reviewer assist (Reviewers), or decide as admin (Applications). The semester can be closed once everything is decided.</p>',
            counts: { pending: 'waiting for a decision', needsInfo: "waiting for the student's reply" },
        },
    },
    de: {
        greeting: (name) => `Liebe/r ${name},`,
        button: 'Anmelden',
        signature: 'PTE-Kreditübertragung',
        noMainReviewer: {
            subject: 'Ein Studiengang hat keine/n Hauptgutachter/in',
            body: ({ programme, extras }) => `<p><strong>${programme}</strong> hat keine/n Hauptgutachter/in mehr. Zusätzliche Gutachter/innen: ${extras}.</p><p>Zusätzliche Gutachter/innen, die mithelfen dürfen, arbeiten weiter an den Anträgen. Wählen Sie unter Gutachter/innen eine neue Hauptperson: Machen Sie eine zusätzliche Person dazu oder laden Sie jemanden ein. Darf niemand mithelfen, warten die Anträge des Studiengangs auf Sie.</p>`,
        },
        // The review deadline passed with undecided applications (round 2 Group 1): nothing is rejected
        reviewDeadlinePassed: {
            subject: 'Die Prüfungsfrist ist abgelaufen: Anträge sind noch offen',
            intro: ({ semester, date }) => `<p>Die Prüfungsfrist von <strong>${semester}</strong> ist abgelaufen (${date}). Diese Anträge sind noch nicht entschieden:</p>`,
            after: '<p>Es wurde nichts abgelehnt. Sie können die Frist verlängern (Semester), eine zusätzliche Person mithelfen lassen (Gutachter/innen) oder als Administration entscheiden (Anträge). Das Semester kann abgeschlossen werden, sobald alles entschieden ist.</p>',
            counts: { pending: 'warten auf eine Entscheidung', needsInfo: 'warten auf die Antwort der Studierenden' },
        },
    },
};

/**
 * An email to one admin, in their language. Every value is escaped here.
 * @param {'noMainReviewer'|'reviewDeadlinePassed'} type
 * @param {{ name: string, programme?: string, extras?: string, semester?: string, deadline?: Date|string,
 *   programmes?: Array<{ name: string, pending: number, needsInfo: number }> }} data
 */
const buildAdminEmail = (type, lang, { name, programme = '', extras = '', semester = '', deadline = null, programmes = [] }) => {
    const language = normalizeLanguage(lang);
    const words = adminTemplates[language];
    const template = words[type];
    if (!template) return null;
    // reviewDeadlinePassed: the undecided counts per programme, as a list (no plural forms needed)
    const body = type === 'reviewDeadlinePassed'
        ? `${template.intro({ semester: escapeHtml(semester), date: deadline ? escapeHtml(formatDeadline(deadline, language)) : '' })}
           <ul>${programmes.map((p) => `<li><strong>${escapeHtml(p.name)}</strong>: ${Number(p.pending) || 0} ${template.counts.pending}, ${Number(p.needsInfo) || 0} ${template.counts.needsInfo}</li>`).join('')}</ul>
           ${template.after}`
        : template.body({ programme: escapeHtml(programme), extras: escapeHtml(extras) });
    const html = `
        <div style="font-family: Arial, sans-serif; color: ${C.textStrong}; max-width: 600px;">
            <h2 style="color: ${C.brand};">${escapeHtml(words.signature)}</h2>
            <p>${escapeHtml(words.greeting(name || ''))}</p>
            ${body}
            <a href="${escapeHtml(`${FRONTEND_URL}/login`)}" style="background-color: ${C.brand}; color: ${C.textOnPrimary}; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">${escapeHtml(words.button)}</a>
            <p style="color: ${C.textMuted}; font-size: 12px; margin-top: 25px;">${escapeHtml(words.signature)}</p>
        </div>`;
    return { subject: template.subject, html };
};

const SUMMARY_LIST_MAX = 30; // longer lists end with "… and N more"

/**
 * The reviewer's daily summary (round 2 Group 1), in their language. Every value is escaped here.
 * @param {{ name: string, newApplications: Array<{ student, course, programme }>, replies: Array<{ student, course, programme }>, waiting: number }} data
 */
const buildReviewerSummaryEmail = (lang, { name, newApplications = [], replies = [], waiting = 0 }) => {
    const language = normalizeLanguage(lang);
    const words = reviewerTemplates[language];
    const template = words.dailySummary;
    const list = (title, items) => {
        if (items.length === 0) return '';
        const shown = items.slice(0, SUMMARY_LIST_MAX).map((i) => `<li><strong>${escapeHtml(i.student)}</strong>, ${escapeHtml(i.course)} (${escapeHtml(i.programme)})</li>`);
        if (items.length > SUMMARY_LIST_MAX) shown.push(`<li>${escapeHtml(template.more(items.length - SUMMARY_LIST_MAX))}</li>`);
        return `<h3 style="color: ${C.brand}; font-size: 15px;">${escapeHtml(title)} (${items.length})</h3><ul>${shown.join('')}</ul>`;
    };
    const html = `
        <div style="font-family: Arial, sans-serif; color: ${C.textStrong}; max-width: 600px;">
            <h2 style="color: ${C.brand};">${escapeHtml(words.signature)}</h2>
            <p>${escapeHtml(words.greeting(name || ''))}</p>
            ${template.intro}
            ${list(template.newApplications, newApplications)}
            ${list(template.replies, replies)}
            ${template.waiting(Number(waiting) || 0)}
            <a href="${escapeHtml(`${FRONTEND_URL}/login`)}" style="background-color: ${C.brand}; color: ${C.textOnPrimary}; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">${escapeHtml(words.button)}</a>
            <p style="color: ${C.textMuted}; font-size: 12px; margin-top: 25px;">${escapeHtml(words.signature)}</p>
        </div>`;
    return { subject: template.subject, html };
};

// Every text table by language, for the translation check (frontend: npm run check:translations)
const translatedTables = { templates, statusLabels, reasons, common, accountTemplates, gradeNames, reviewerTemplates, staffRoleLabels, adminTemplates };

module.exports = { buildEmail, buildAccountEmail, buildReviewerEmail, buildReviewerSummaryEmail, buildAdminEmail, gradeLabel, normalizeLanguage, escapeHtml, statusLabels, templates, reasons, staffRoleLabels, translatedTables };
