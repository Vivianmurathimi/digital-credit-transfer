import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../http';
import { getErrorMessage } from '../errorMessage';
import { formatDate } from '../dates';

// Allowed email domains (admin round Group 3): students can register only with an address from a
// domain on this list (exact match). Removing a domain blocks new sign-ups only. With an empty list
// nobody can register, and a red warning says so. The server checks the format again.

const card = { backgroundColor: 'var(--surface)', padding: '20px', borderRadius: '10px', border: '2px solid var(--border)', marginBottom: '30px' };
const warning = { backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', border: '1px solid var(--danger-border)', padding: '12px', borderRadius: '6px', fontWeight: 'bold', marginBottom: '15px' };

// onChange: called after a change (the admin menu's badges refresh)
const AllowedDomains = ({ onChange = () => {} }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const [domains, setDomains] = useState(null);
    const [newDomain, setNewDomain] = useState('');
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        try {
            setDomains((await http.get('admin/domains').json()).domains);
        } catch (err) { setError(getErrorMessage(err, t, 'domains_load_failed')); }
    }, [t]);
    useEffect(() => { load(); }, [load]);

    const add = async (e) => {
        e.preventDefault();
        setError('');
        setSaving(true);
        try {
            await http.post('admin/domains', { json: { domain: newDomain } }).json();
            setNewDomain('');
            load();
            onChange();
        } catch (err) {
            setError(getErrorMessage(err, t, 'domains_add_failed'));
        } finally {
            setSaving(false);
        }
    };

    const remove = async (row) => {
        if (!window.confirm(t('domains_confirm_remove', { domain: row.domain }))) return;
        setError('');
        try {
            await http.delete(`admin/domains/${row.id}`).json();
        } catch (err) { setError(getErrorMessage(err, t, 'domains_remove_failed')); }
        load();
        onChange();
    };

    return (
        <section aria-labelledby="domains-title" style={card}>
            <h2 id="domains-title" style={{ marginTop: 0, color: 'var(--heading)' }}>{t('domains_title')}</h2>
            <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{t('domains_intro')}</p>
            {domains && domains.length === 0 && <div role="alert" style={warning}>{t('domains_empty_warning')}</div>}

            <form onSubmit={add} noValidate style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'end', marginBottom: '15px' }}>
                <div style={{ flex: '1 1 240px' }}>
                    <label htmlFor="domain-new" style={{ display: 'block', fontWeight: 'bold', marginBottom: '4px' }}>{t('domains_new_label')}</label>
                    <input
                        id="domain-new" type="text" value={newDomain} maxLength={254} autoComplete="off" spellCheck={false}
                        onChange={(e) => { setNewDomain(e.target.value); setError(''); }}
                        placeholder={t('domains_new_placeholder')}
                        style={{ width: '100%', padding: '8px', boxSizing: 'border-box', border: '1px solid var(--border-strong)', borderRadius: '4px', font: 'inherit' }}
                    />
                </div>
                <button type="submit" disabled={saving || !newDomain.trim()} style={{ padding: '9px 16px', backgroundColor: 'var(--brand)', color: 'var(--text-on-primary)', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: saving ? 'wait' : 'pointer' }}>
                    {t('domains_add_button')}
                </button>
            </form>
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}

            {domains && domains.length > 0 && (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {domains.map((row) => (
                        <li key={row.id} style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                            <span style={{ overflowWrap: 'anywhere' }}>
                                <strong>{row.domain}</strong>
                                <span style={{ color: 'var(--text-muted)', fontSize: '13px', marginLeft: '8px' }}>
                                    {t(row.added_by_name ? 'domains_added_by' : 'domains_added_start', { name: row.added_by_name, date: formatDate(row.created_at, language) })}
                                </span>
                            </span>
                            <button type="button" onClick={() => remove(row)} style={{ padding: '5px 10px', borderRadius: '4px', fontWeight: 'bold', cursor: 'pointer', border: '1px solid var(--danger-border)', backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)' }}>
                                {t('domains_remove_button')}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
};

export default AllowedDomains;
