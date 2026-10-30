// Dates and times as the student reads them: in their language, and always in Budapest time
// (where the university is), whatever time zone the computer is set to.
const LOCALES = { en: 'en-GB', hu: 'hu-HU', de: 'de-DE' };
const TIME_ZONE = 'Europe/Budapest';

const format = (at, language, options) => (at
    ? new Intl.DateTimeFormat(LOCALES[language] || LOCALES.en, { timeZone: TIME_ZONE, ...options }).format(new Date(at))
    : '');

// "30 October 2026"
export const formatDate = (at, language) => format(at, language, { year: 'numeric', month: 'long', day: 'numeric' });

// "30 October 2026, 14:30"
export const formatDateTime = (at, language) => format(at, language, {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
