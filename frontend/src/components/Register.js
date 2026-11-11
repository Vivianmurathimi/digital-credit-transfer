import React, { useEffect, useState } from 'react';
import http from '../http';
import { useTranslation } from 'react-i18next';
import { getErrorCode, getErrorMessage } from '../errorMessage';
import PasswordInput from './PasswordInput';
import { programmeName } from '../programmeName';
import { formatDateTime } from '../dates';

// Registration always creates a student (admin round Groups 2 and 3), so the Neptun code and the
// programme are always asked. Which email domains may register is the admin's list on the server
// (no domain is written here); an address from another domain gets EMAIL_DOMAIN_NOT_ALLOWED,
// shown under the email field. Reviewers and admins are invited, never registered.

// Same rule as the backend and the database: 6 letters or digits, upper case
const NEPTUN_PATTERN = /^[A-Z0-9]{6}$/;
const cleanNeptun = (value) => value.replace(/\s/g, '').toUpperCase();

// Server error codes shown under their own field; everything else goes in the box at the top
const FIELD_FOR_CODE = {
    INVALID_NEPTUN: 'neptun',
    NEPTUN_TAKEN: 'neptun',
    INVALID_PROGRAMME: 'programme',
    EMAIL_TAKEN: 'email',
    EMAIL_DOMAIN_NOT_ALLOWED: 'email',
};

const inputStyle = (hasError) => ({
    width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px',
    border: `1px solid ${hasError ? 'var(--danger-border)' : 'var(--border-strong)'}`, borderRadius: '4px',
});

const FieldError = ({ id, message }) => (message
    ? <div id={id} style={{ color: 'var(--error-text)', fontSize: '13px', marginTop: '4px', fontWeight: 'bold' }}>{message}</div>
    : null);

const Register = () => {
    const { t, i18n } = useTranslation();
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [neptun, setNeptun] = useState('');
    const [programmeCode, setProgrammeCode] = useState('');
    const [programmes, setProgrammes] = useState([]);
    const [programmesFailed, setProgrammesFailed] = useState(false);
    const [error, setError] = useState('');
    const [fieldErrors, setFieldErrors] = useState({});
    const [isRegistered, setIsRegistered] = useState(false);

    // The application period (admin round Group 5): when closed, the page says so with the next
    // opening time. The form stays usable, because someone with late access may still register;
    // the server decides.
    const [period, setPeriod] = useState(null);

    useEffect(() => {
        http.get('programmes').json()
            .then((data) => setProgrammes(data.programmes || []))
            .catch(() => setProgrammesFailed(true));
        http.get('settings/period').json()
            .then((data) => setPeriod(data.period))
            .catch(() => setPeriod(null));
    }, []);
    const periodLanguage = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2);

    const setFieldError = (field, message) => setFieldErrors((prev) => ({ ...prev, [field]: message }));

    const neptunError = (value) => (NEPTUN_PATTERN.test(value) ? '' : t('errors.INVALID_NEPTUN'));

    const handleEmailChange = (value) => {
        setEmail(value);
        setFieldError('email', '');
    };

    const handleRegister = async (e) => {
        e.preventDefault();
        setError('');

        // Same checks as the server, before sending (shown under the fields)
        const checks = { neptun: neptunError(neptun), programme: programmeCode ? '' : t('errors.INVALID_PROGRAMME') };
        setFieldErrors((prev) => ({ ...prev, ...checks }));
        if (checks.neptun || checks.programme) return;

        const body = { name, email, password, language: i18n.language, neptun_code: neptun, programme_code: programmeCode };

        try {
            const data = await http.post('register', { json: body }).json();
            if (data.success) {
                setIsRegistered(true);
            }
        } catch (err) {
            const message = getErrorMessage(err, t, 'register_error_default');
            const field = FIELD_FOR_CODE[getErrorCode(err)];
            if (field) setFieldError(field, message);
            else setError(message);
        }
    };

    return (
        <div style={{ maxWidth: '400px', margin: '50px auto', padding: '20px', border: '1px solid var(--border-strong)', borderRadius: '8px', backgroundColor: 'var(--surface-2)' }}>
            {isRegistered ? (
                <div style={{ textAlign: 'center', padding: '30px', backgroundColor: 'var(--success-bg)', borderRadius: '8px', color: 'var(--success-text)', border: '1px solid var(--success-border)' }}>
                    <h2 style={{ marginTop: 0 }}>{t('register_success_title')}</h2>
                    <p style={{ marginBottom: 0 }}>{t('register_success_message')}</p>
                </div>
            ) : (
                <>
                    <h2 style={{ textAlign: 'center', color: 'var(--success-accent)', marginTop: 0 }}>{t('register_title')}</h2>

                    {period && !period.canRegister && (
                        <div role="status" style={{ backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)', border: '1px solid var(--orange)', padding: '10px', borderRadius: '5px', marginBottom: '15px' }}>
                            <strong>{t('register_period_closed')}</strong>
                            {period.state === 'not_started' && period.semester?.opensAt && (
                                <div>{t('register_period_opens', { date: formatDateTime(period.semester.opensAt, periodLanguage) })}</div>
                            )}
                            <div style={{ fontSize: '13px', marginTop: '4px' }}>{t('register_period_late_access')}</div>
                        </div>
                    )}

                    {error && <div role="alert" style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', padding: '10px', borderRadius: '5px', marginBottom: '15px', fontWeight: 'bold', textAlign: 'center', border: '1px solid var(--danger-border)' }}>{error}</div>}

                    <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                        <div>
                            <label htmlFor="register-name" style={{ fontWeight: 'bold' }}>{t('register_full_name')}</label>
                            <input id="register-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required style={inputStyle(false)} placeholder={t('register_full_name_placeholder')} />
                        </div>
                        <div>
                            <label htmlFor="register-email" style={{ fontWeight: 'bold' }}>{t('register_email')}</label>
                            <input
                                id="register-email" type="email" value={email} required
                                onChange={(e) => handleEmailChange(e.target.value)}
                                aria-invalid={!!fieldErrors.email} aria-describedby={fieldErrors.email ? 'register-email-error' : undefined}
                                style={inputStyle(!!fieldErrors.email)} placeholder={t('register_email_placeholder')}
                            />
                            <FieldError id="register-email-error" message={fieldErrors.email} />
                        </div>

                        {(
                            <>
                                <div>
                                    <label htmlFor="register-neptun" style={{ fontWeight: 'bold' }}>{t('register_neptun')}</label>
                                    <input
                                        id="register-neptun" type="text" value={neptun} autoComplete="off" spellCheck={false}
                                        // Upper case while typing; spaces removed (also when pasted)
                                        onChange={(e) => { setNeptun(cleanNeptun(e.target.value)); setFieldError('neptun', ''); }}
                                        // Checked when leaving the field, not on every keystroke
                                        onBlur={() => { if (neptun) setFieldError('neptun', neptunError(neptun)); }}
                                        aria-invalid={!!fieldErrors.neptun} aria-describedby={fieldErrors.neptun ? 'register-neptun-error' : 'register-neptun-hint'}
                                        style={{ ...inputStyle(!!fieldErrors.neptun), textTransform: 'uppercase', letterSpacing: '2px' }}
                                        placeholder={t('register_neptun_placeholder')}
                                    />
                                    {fieldErrors.neptun
                                        ? <FieldError id="register-neptun-error" message={fieldErrors.neptun} />
                                        : <div id="register-neptun-hint" style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px' }}>{t('register_neptun_hint')}</div>}
                                </div>
                                <div>
                                    <label htmlFor="register-programme" style={{ fontWeight: 'bold' }}>{t('register_programme')}</label>
                                    <select
                                        id="register-programme" value={programmeCode} disabled={programmesFailed}
                                        onChange={(e) => { setProgrammeCode(e.target.value); setFieldError('programme', ''); }}
                                        aria-invalid={!!fieldErrors.programme} aria-describedby={fieldErrors.programme ? 'register-programme-error' : undefined}
                                        style={inputStyle(!!fieldErrors.programme)}
                                    >
                                        <option value="">{t('register_programme_placeholder')}</option>
                                        {programmes.map((p) => <option key={p.code} value={p.code}>{programmeName(p, i18n)}</option>)}
                                    </select>
                                    <FieldError id="register-programme-error" message={programmesFailed ? t('register_programmes_load_failed') : fieldErrors.programme} />
                                </div>
                            </>
                        )}

                        <div>
                            <label htmlFor="register-password" style={{ fontWeight: 'bold' }}>{t('register_password')}</label>
                            <PasswordInput id="register-password" value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle(false)} placeholder={t('register_password_placeholder')} />
                        </div>

                        <button type="submit" style={{ padding: '12px', backgroundColor: 'var(--accent)', color: 'var(--text-on-primary)', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '16px', marginTop: '10px' }}>
                             {t('register_button')}
                        </button>
                    </form>

                    <p style={{ textAlign: 'center', marginTop: '20px', fontSize: '14px' }}>
                        {t('register_already_account')} <a href="/login" style={{ color: 'var(--link)', fontWeight: 'bold', textDecoration: 'none' }}>{t('register_login_link')}</a>
                    </p>
                </>
            )}
        </div>
    );
};

export default Register;
