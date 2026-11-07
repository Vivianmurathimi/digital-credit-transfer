import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import http from '../http';
import { getErrorMessage, getFieldErrors } from '../errorMessage';
import PasswordInput from './PasswordInput';
import { programmeName } from '../programmeName';
import { MIN_PASSWORD_LENGTH, isPasswordLongEnough } from '../passwordRules';

// The reviewer invite page (reviewer Group 2), opened from the invite email: /invite/:token.
// The invited person sets their name and a password; the account becomes the programme's
// reviewer and counts as email-verified. A removed reviewer invited again keeps their name
// (it stays on their old decisions), so it is shown read-only and only the password is set.

const boxStyle = { maxWidth: '420px', margin: '50px auto', padding: '20px', border: '1px solid var(--border-strong)', borderRadius: '8px', backgroundColor: 'var(--surface-2)' };
const inputStyle = { width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid var(--border-strong)', borderRadius: '4px' };
const readOnlyStyle = { ...inputStyle, backgroundColor: 'var(--surface)', color: 'var(--text-muted)' };
const fieldErrorStyle = { color: 'var(--error-text)', fontSize: '13px', marginTop: '4px' };
const dangerBox = { backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', padding: '10px', borderRadius: '5px', marginBottom: '15px', border: '1px solid var(--danger-border)', textAlign: 'center' };
const successBox = { backgroundColor: 'var(--success-bg)', color: 'var(--success-text)', padding: '20px', borderRadius: '8px', border: '1px solid var(--success-border)', textAlign: 'center' };

const AcceptInvite = () => {
    const { t, i18n } = useTranslation();
    const { token } = useParams();

    const [invite, setInvite] = useState(null);
    const [loadError, setLoadError] = useState('');
    const [name, setName] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [fieldErrors, setFieldErrors] = useState({});
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const [done, setDone] = useState(false);

    useEffect(() => {
        http.get(`invites/${token}`).json()
            .then((data) => setInvite(data.invite))
            .catch((err) => setLoadError(getErrorMessage(err, t, 'invite_error_default')));
    }, [token, t]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');

        // Same checks as the server, before sending (shown under the fields)
        const checks = {
            name: invite.existingName || name.trim() ? '' : t('errors.MISSING_FIELDS'),
            password: isPasswordLongEnough(password) ? '' : t('errors.PASSWORD_TOO_SHORT', { min: MIN_PASSWORD_LENGTH }),
            confirm: password === confirmPassword ? '' : t('reset_error_password_mismatch'),
        };
        setFieldErrors(checks);
        if (checks.name || checks.password || checks.confirm) return;

        setSaving(true);
        try {
            await http.post(`invites/${token}/accept`, { json: { name: invite.existingName ? undefined : name, password } }).json();
            setDone(true);
        } catch (err) {
            const fields = getFieldErrors(err, t);
            if (fields.password || fields.name) setFieldErrors({ name: fields.name || '', password: fields.password || '', confirm: '' });
            else setError(getErrorMessage(err, t, 'invite_error_default'));
        } finally {
            setSaving(false);
        }
    };

    if (done) {
        return (
            <div style={boxStyle}>
                <div role="status" style={successBox}>
                    <h2 style={{ marginTop: 0 }}>{t('invite_success_title')}</h2>
                    <p>{t('invite_success_message')}</p>
                    <a href="/login" style={{ color: 'var(--link)', fontWeight: 'bold' }}>{t('invite_go_to_login')}</a>
                </div>
            </div>
        );
    }

    if (loadError) {
        return (
            <div style={boxStyle}>
                <h2 style={{ textAlign: 'center', color: 'var(--link)', marginTop: 0 }}>{t('invite_title')}</h2>
                <div role="alert" style={dangerBox}>{loadError}</div>
                <p style={{ textAlign: 'center' }}><a href="/login" style={{ color: 'var(--link)' }}>{t('invite_go_to_login')}</a></p>
            </div>
        );
    }

    if (!invite) {
        return <div style={boxStyle}><p role="status" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{t('invite_loading')}</p></div>;
    }

    return (
        <div style={boxStyle}>
            <h2 style={{ textAlign: 'center', color: 'var(--link)', marginTop: 0 }}>{t('invite_title')}</h2>
            <p>{t('invite_intro', { programme: programmeName(invite.programme, i18n) })}</p>

            {error && <div role="alert" style={dangerBox}>{error}</div>}

            <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                <div>
                    <label htmlFor="invite-email" style={{ fontWeight: 'bold' }}>{t('invite_email_label')}</label>
                    <input id="invite-email" type="email" value={invite.email} readOnly style={readOnlyStyle} />
                </div>
                <div>
                    <label htmlFor="invite-name" style={{ fontWeight: 'bold' }}>{t('invite_name_label')}</label>
                    {invite.existingName ? (
                        <>
                            <input id="invite-name" type="text" value={invite.existingName} readOnly style={readOnlyStyle} aria-describedby="invite-name-hint" />
                            <div id="invite-name-hint" style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>{t('invite_name_kept_hint')}</div>
                        </>
                    ) : (
                        <input
                            id="invite-name" type="text" value={name} maxLength={100} autoComplete="name"
                            onChange={(e) => { setName(e.target.value); setFieldErrors((prev) => ({ ...prev, name: '' })); }}
                            style={inputStyle} aria-invalid={!!fieldErrors.name}
                        />
                    )}
                    {fieldErrors.name && <div role="alert" style={fieldErrorStyle}>{fieldErrors.name}</div>}
                </div>
                <div>
                    <label htmlFor="invite-password" style={{ fontWeight: 'bold' }}>{t('invite_password_label')}</label>
                    <PasswordInput
                        id="invite-password" value={password}
                        onChange={(e) => { setPassword(e.target.value); setFieldErrors((prev) => ({ ...prev, password: '' })); }}
                        style={inputStyle} placeholder={t('invite_password_hint', { min: MIN_PASSWORD_LENGTH })}
                    />
                    {fieldErrors.password && <div role="alert" style={fieldErrorStyle}>{fieldErrors.password}</div>}
                </div>
                <div>
                    <label htmlFor="invite-confirm" style={{ fontWeight: 'bold' }}>{t('invite_confirm_label')}</label>
                    <PasswordInput
                        id="invite-confirm" value={confirmPassword}
                        onChange={(e) => { setConfirmPassword(e.target.value); setFieldErrors((prev) => ({ ...prev, confirm: '' })); }}
                        style={inputStyle}
                    />
                    {fieldErrors.confirm && <div role="alert" style={fieldErrorStyle}>{fieldErrors.confirm}</div>}
                </div>
                <button type="submit" disabled={saving} style={{ padding: '12px', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: '5px', cursor: saving ? 'wait' : 'pointer', fontWeight: 'bold', fontSize: '16px' }}>
                    {t('invite_button')}
                </button>
            </form>
        </div>
    );
};

export default AcceptInvite;
