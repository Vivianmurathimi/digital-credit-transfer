import i18n from './i18n';

/**
 * Turns a failed request into a message in the user's language.
 *
 * The backend answers errors as { error: 'English text', code: 'MACHINE_CODE' }.
 * ky puts that body on err.data; axios puts it on err.response.data.
 * 1. Known code    -> the translated errors.<CODE> text
 * 2. No answer     -> "Cannot connect to server" (backend down or offline)
 * 3. Anything else -> the page's own fallback text
 */
export const getErrorMessage = (err, t, fallbackKey) => {
    const code = getErrorCode(err);
    if (code && i18n.exists(`errors.${code}`)) return t(`errors.${code}`);
    if (err && !err.response) return t('errors.network_error');
    return t(fallbackKey);
};

// File downloads use responseType 'blob', so an error answer arrives as a Blob too.
// This turns it back into { error, code } so getErrorMessage can translate it.
export const unpackBlobError = async (err) => {
    const data = err?.response?.data;
    if (data instanceof Blob && data.type.includes('application/json')) {
        try { err.response.data = JSON.parse(await data.text()); } catch { /* leave as is */ }
    }
    return err;
};

/**
 * Server errors that belong to single form fields, translated:
 *   { 'fulfilled_courses[1].credits': 'Credits must be …', 'institutions[0].country': '…' }
 * Read from the optional `errors` list ({ field, code, error, params }) or, if there is none,
 * from the top-level `field`. A known code is translated (with its params, e.g. { max: 60 });
 * otherwise the server's English text is used. Only the first message per field is kept.
 * The form decides where each path goes; paths it doesn't know belong in the top message.
 */
export const getFieldErrors = (err, t) => {
    const data = err?.data || err?.response?.data;
    const list = Array.isArray(data?.errors)
        ? data.errors
        : (data?.field ? [{ field: data.field, code: data.code, error: data.error }] : []);
    const result = {};
    for (const item of list) {
        if (!item || typeof item.field !== 'string' || item.field in result) continue;
        result[item.field] = item.code && i18n.exists(`errors.${item.code}`)
            ? t(`errors.${item.code}`, item.params || {})
            : (item.error || '');
    }
    return result;
};

// The machine code alone, for pages that react to a specific error
export const getErrorCode = (err) => err?.data?.code || err?.response?.data?.code || null;
