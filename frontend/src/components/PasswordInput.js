import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

// Password field with an eye button to show or hide what was typed.
// Hidden by default; each field keeps its own show/hide state.
const PasswordInput = ({ value, onChange, placeholder, style }) => {
    const { t } = useTranslation();
    const [visible, setVisible] = useState(false);
    const label = t(visible ? 'password_hide' : 'password_show');

    return (
        <div style={{ position: 'relative', marginTop: '5px' }}>
            <input
                type={visible ? 'text' : 'password'}
                value={value}
                onChange={onChange}
                placeholder={placeholder}
                required
                style={{ ...style, marginTop: 0, paddingRight: '40px' }}
            />
            {/* type="button" so clicking the eye never submits the form */}
            <button
                type="button"
                onClick={() => setVisible((v) => !v)}
                aria-label={label}
                title={label}
                style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px', color: 'var(--text-muted)', display: 'flex' }}
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                    {visible && <line x1="3" y1="3" x2="21" y2="21" />}
                </svg>
            </button>
        </div>
    );
};

export default PasswordInput;
