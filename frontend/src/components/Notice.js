import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { onNotice } from '../notice';

const SHOW_FOR_MS = 6000;

// App-wide banner for notices from the HTTP clients (e.g. "You are not allowed to do this.")
const Notice = () => {
    const { t } = useTranslation();
    const [code, setCode] = useState(null);

    useEffect(() => onNotice(setCode), []);

    // Hide again after a few seconds
    useEffect(() => {
        if (!code) return undefined;
        const timer = setTimeout(() => setCode(null), SHOW_FOR_MS);
        return () => clearTimeout(timer);
    }, [code]);

    if (!code) return null;

    return (
        <div role="alert" style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', border: '1px solid var(--danger-border)', padding: '12px 20px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '15px', fontWeight: 'bold' }}>
            <span>{t(`errors.${code}`)}</span>
            <button
                onClick={() => setCode(null)}
                aria-label={t('notice_close')}
                title={t('notice_close')}
                style={{ background: 'none', border: 'none', color: 'inherit', fontSize: '18px', cursor: 'pointer', lineHeight: 1 }}
            >
                ×
            </button>
        </div>
    );
};

export default Notice;
