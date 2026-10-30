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

// A calendar day sent as 'YYYY-MM-DD' (e.g. the last day of the application period), written out:
// "15 November 2026". It is already a Budapest day, so it is formatted as is, never shifted.
export const formatDay = (day, language) => (day
    ? new Intl.DateTimeFormat(LOCALES[language] || LOCALES.en, { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' })
        .format(new Date(`${day}T00:00:00Z`))
    : '');
