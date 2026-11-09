import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getErrorMessage } from '../../errorMessage';
import { openSecureFile } from '../../secureFiles';

/**
 * One evidence file as a link that opens in a new tab. Files need the login token, so a plain
 * <a href> can't load them: openSecureFile fetches the file with the token first (like the student
 * side). A file that no longer exists is shown as missing; a refused or failed open shows its
 * reason next to the link instead of a blank tab.
 * @param info  { exists, original_name } from the details endpoint
 */
const FileLink = ({ fileName, info, label }) => {
    const { t } = useTranslation();
    const [error, setError] = useState('');
    const shownName = info?.original_name || fileName;

    if (info && !info.exists) {
        return (
            <div style={{ fontSize: '14px' }}>
                {label && <span style={{ fontWeight: 'bold' }}>{label}: </span>}
                <span style={{ color: 'var(--error-text)' }}>{t('reviewer_file_missing', { name: shownName })}</span>
            </div>
        );
    }

    const open = () => {
        setError('');
        openSecureFile(fileName).catch((err) => setError(getErrorMessage(err, t, 'file_open_failed')));
    };

    return (
        <div style={{ fontSize: '14px' }}>
            {label && <span style={{ fontWeight: 'bold' }}>{label}: </span>}
            <button
                type="button" onClick={open} title={t('reviewer_open_file')}
                style={{ cursor: 'pointer', border: 'none', background: 'none', padding: 0, color: 'var(--link)', textDecoration: 'underline', font: 'inherit', textAlign: 'left', wordBreak: 'break-all' }}
            >
                📄 {shownName}
            </button>
            {error && <div role="alert" style={{ color: 'var(--error-text)', fontSize: '13px', marginTop: '2px' }}>{error}</div>}
        </div>
    );
};

export default FileLink;
