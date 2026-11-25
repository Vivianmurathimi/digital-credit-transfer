import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../http';
import { getErrorMessage } from '../errorMessage';

// The daily summary emails a reviewer or committee member can switch off (professor's review notes;
// migration 031). The server says which switches apply (GET /api/me/email-settings): the reviewer
// summary, the committee summary, or both for a reviewer on a committee. Each switch saves on change;
// on an error it goes back. Deadline reminders and other emails always come, so they have no switch.
// acting: the admin acting as this person sees the settings but can't change them (the server refuses too).
export const SWITCH_ORDER = ['reviewerSummary', 'committeeSummary'];

const EmailSettings = ({ acting = false }) => {
    const { t } = useTranslation();
    const [settings, setSettings] = useState(null);
    const [saving, setSaving] = useState('');
    const [message, setMessage] = useState(null); // { kind: 'saved' | 'error', text }

    useEffect(() => {
        let current = true;
        http.get('me/email-settings').json()
            .then((data) => { if (current) setSettings(data.settings || {}); })
            .catch(() => { if (current) setSettings({}); });
        return () => { current = false; };
    }, []);

    const shown = SWITCH_ORDER.filter((key) => settings && key in settings);
    if (shown.length === 0) return null;

    const change = async (key, value) => {
        const before = settings[key];
        setSettings((prev) => ({ ...prev, [key]: value }));
        setSaving(key);
        setMessage(null);
        try {
            const data = await http.put('me/email-settings', { json: { [key]: value } }).json();
            setSettings(data.settings);
            setMessage({ kind: 'saved', text: t('email_settings_saved') });
        } catch (err) {
            setSettings((prev) => ({ ...prev, [key]: before }));
            setMessage({ kind: 'error', text: getErrorMessage(err, t, 'email_settings_failed') });
        } finally {
            setSaving('');
        }
    };

    return (
        <section aria-labelledby="email-settings-title" style={{ marginTop: '30px', padding: '16px', borderRadius: '8px', border: '1px solid var(--section-border)', backgroundColor: 'var(--section-bg)' }}>
            <h3 id="email-settings-title" style={{ marginTop: 0, color: 'var(--heading)' }}>{t('email_settings_title')}</h3>
            {acting && <p role="note" style={{ marginTop: 0, color: 'var(--text-muted)' }}>{t('email_settings_acting')}</p>}
            {shown.map((key) => (
                <label key={key} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '8px', cursor: acting ? 'not-allowed' : 'pointer' }}>
                    <input
                        type="checkbox" checked={!!settings[key]} disabled={acting || saving === key}
                        onChange={(e) => change(key, e.target.checked)} style={{ marginTop: '3px' }}
                    />
                    <span>
                        <strong>{t(`email_settings_${key}`)}</strong>
                        <span style={{ display: 'block', fontSize: '13px', color: 'var(--text-muted)' }}>{t(`email_settings_${key}_hint`)}</span>
                    </span>
                </label>
            ))}
            <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>{t('email_settings_always')}</p>
            {message && (
                <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ margin: '8px 0 0', fontWeight: 'bold', color: message.kind === 'error' ? 'var(--error-text)' : 'var(--success-text)' }}>
                    {message.text}
                </p>
            )}
        </section>
    );
};

export default EmailSettings;
