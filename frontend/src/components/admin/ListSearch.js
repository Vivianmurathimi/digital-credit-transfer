import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';

// A search box above an admin list (fixes 3a): filters as you type (the list is searched in the
// browser), with a × that clears it and puts the cursor back. Escape clears it too.
const ListSearch = ({ id, label, placeholder, value, onChange }) => {
    const { t } = useTranslation();
    const inputRef = useRef(null);
    const clear = () => { onChange(''); inputRef.current?.focus(); };
    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', margin: '0 0 10px' }}>
            <label htmlFor={id} style={{ fontWeight: 'bold' }}>{label}</label>
            <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: '420px' }}>
                <input
                    ref={inputRef} id={id} type="text" value={value} placeholder={placeholder} autoComplete="off"
                    onChange={(e) => onChange(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.preventDefault(); clear(); } }}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '8px 34px 8px 10px', border: '1px solid var(--border-strong)', borderRadius: '4px', backgroundColor: 'var(--surface)', color: 'var(--text)', font: 'inherit' }}
                />
                {value && (
                    <button
                        type="button" onClick={clear} aria-label={t('list_search_clear')} title={t('list_search_clear')}
                        style={{ position: 'absolute', right: '4px', top: '50%', transform: 'translateY(-50%)', width: '28px', height: '28px', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '18px', lineHeight: 1 }}
                    >
                        ×
                    </button>
                )}
            </div>
        </div>
    );
};

export default ListSearch;
