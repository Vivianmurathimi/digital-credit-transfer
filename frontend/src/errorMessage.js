import i18n from './i18n';

/**
 * Turns a failed request into a message in the user's language.
 *
 * The backend answers errors as { error: 'English text', code: 'MACHINE_CODE' }.
 * 1. Known code    -> the translated errors.<CODE> text
 * 2. No answer     -> "Cannot connect to server" (backend down or offline)
 * 3. Anything else -> the page's own fallback text
 */
export const getErrorMessage = (err, t, fallbackKey) => {
    const code = err?.response?.data?.code;
    if (code && i18n.exists(`errors.${code}`)) return t(`errors.${code}`);
    if (err && !err.response) return t('errors.network_error');
    return t(fallbackKey);
};

// The machine code alone, for pages that react to a specific error
export const getErrorCode = (err) => err?.response?.data?.code || null;
