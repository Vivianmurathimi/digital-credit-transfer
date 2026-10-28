// A programme's name in the current language ({ name_en, name_hu, name_de } from the backend).
// Falls back to English if a name is missing.
export const programmeName = (programme, i18n) => {
    const language = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2);
    return programme[`name_${language}`] || programme.name_en;
};
