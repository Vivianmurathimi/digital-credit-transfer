import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../http';
import { getErrorMessage } from '../errorMessage';
import { formatDate } from '../dates';
import { programmeName } from '../programmeName';
import Chip from './reviewer/Chip';

// Staff access (admin round Group 2): reviewers and admins get in only by invite.
// - Invite: email, role, programme (reviewers), "replace the current reviewer", email language
// - Invites: every invite with its status (sent / accepted / expired / cancelled), resend, cancel
// - Reviewers and admins: remove a reviewer, deactivate an admin
// The server enforces every rule (one reviewer per programme, not yourself, not the last admin);
// the buttons are only hidden where the server would refuse anyway.

const STATUS_CUES = { sent: 'pending', accepted: 'approved', expired: 'needs-info', cancelled: 'neutral' };
const LANGUAGES = ['hu', 'en', 'de'];

const card = { backgroundColor: 'var(--surface)', padding: '20px', borderRadius: '10px', border: '2px solid var(--border)', marginBottom: '30px' };
const label = { display: 'block', fontWeight: 'bold', marginBottom: '4px' };
const input = { width: '100%', padding: '8px', boxSizing: 'border-box', border: '1px solid var(--border-strong)', borderRadius: '4px', font: 'inherit' };
const th = { padding: '8px', textAlign: 'left', borderBottom: '2px solid var(--border)', fontSize: '14px' };
const td = { padding: '8px', borderBottom: '1px solid var(--border-subtle)', fontSize: '14px', verticalAlign: 'top', overflowWrap: 'anywhere' };
const smallButton = (danger = false) => ({
    padding: '5px 10px', marginRight: '6px', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold', font: 'inherit',
    border: `1px solid ${danger ? 'var(--danger-border)' : 'var(--border-strong)'}`,
    backgroundColor: danger ? 'var(--danger-bg)' : 'var(--surface)', color: danger ? 'var(--danger-text)' : 'var(--text)',
});

const StaffAccess = () => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;

    const [programmes, setProgrammes] = useState([]);
    const [invites, setInvites] = useState([]);
    const [staff, setStaff] = useState([]);
    const [statusFilter, setStatusFilter] = useState('');
    const [loadError, setLoadError] = useState('');

    const [form, setForm] = useState({ email: '', role: 'reviewer', programme_code: '', replace: false, language: 'hu' });
    const [formError, setFormError] = useState('');
    const [sending, setSending] = useState(false);
    const [created, setCreated] = useState(null); // { email, link } of the last invite sent or resent
    const [actionError, setActionError] = useState('');

    const loadInvites = useCallback(async () => {
        try {
            const data = await http.get('users/invites', { searchParams: statusFilter ? { status: statusFilter } : {} }).json();
            setInvites(data.invites);
        } catch (err) { setLoadError(getErrorMessage(err, t, 'staff_load_failed')); }
    }, [statusFilter, t]);

    const loadStaff = useCallback(async () => {
        try {
            setStaff((await http.get('users/staff').json()).staff);
        } catch (err) { setLoadError(getErrorMessage(err, t, 'staff_load_failed')); }
    }, [t]);

    useEffect(() => {
        http.get('programmes').json().then((data) => setProgrammes(data.programmes || [])).catch(() => setProgrammes([]));
        loadStaff();
    }, [loadStaff]);
    useEffect(() => { loadInvites(); }, [loadInvites]);

    const setField = (field, value) => { setForm((prev) => ({ ...prev, [field]: value })); setFormError(''); };

    const sendInvite = async (e) => {
        e.preventDefault();
        setFormError('');
        setCreated(null);
        if (form.role === 'reviewer' && !form.programme_code) { setFormError(t('errors.INVALID_PROGRAMME')); return; }
        setSending(true);
        try {
            const json = { email: form.email.trim(), role: form.role, language: form.language };
            if (form.role === 'reviewer') Object.assign(json, { programme_code: form.programme_code, replace: form.replace });
            const data = await http.post('users/invites', { json }).json();
            setCreated({ email: data.invite.email, link: data.link });
            setForm((prev) => ({ ...prev, email: '', replace: false }));
            loadInvites();
        } catch (err) {
            setFormError(getErrorMessage(err, t, 'staff_invite_failed'));
        } finally {
            setSending(false);
        }
    };

    // Runs one action after a confirmation, then reloads both lists
    const act = async (confirmText, request) => {
        if (confirmText && !window.confirm(confirmText)) return;
        setActionError('');
        try {
            const data = await request();
            if (data?.link) setCreated({ email: data.invite.email, link: data.link });
        } catch (err) {
            setActionError(getErrorMessage(err, t, 'staff_action_failed'));
        }
        loadInvites();
        loadStaff();
    };

    const roleName = (role) => t(role === 'superadmin' ? 'staff_role_admin' : 'staff_role_reviewer');
    const reviewers = staff.filter((person) => person.role === 'reviewer');
    const admins = staff.filter((person) => person.role === 'superadmin');
    const activeAdmins = admins.filter((person) => !person.deactivated_at).length;
    const statusChip = (person) => (person.deactivated_at
        ? <Chip cue="neutral">{t('staff_status_deactivated', { date: formatDate(person.deactivated_at, language) })}</Chip>
        : <Chip cue="approved">{t('staff_status_active')}</Chip>);

    return (
        <section aria-labelledby="staff-access-title" style={card}>
            <h2 id="staff-access-title" style={{ marginTop: 0, color: 'var(--heading)' }}>{t('staff_title')}</h2>
            <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{t('staff_intro')}</p>
            {loadError && <p role="alert" style={{ color: 'var(--error-text)' }}>{loadError}</p>}

            {/* Invite */}
            <h3>{t('staff_invite_title')}</h3>
            <form onSubmit={sendInvite} noValidate style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', alignItems: 'end' }}>
                <div>
                    <label htmlFor="staff-email" style={label}>{t('staff_email_label')}</label>
                    <input id="staff-email" type="email" value={form.email} maxLength={100} onChange={(e) => setField('email', e.target.value)} style={input} />
                </div>
                <div>
                    <label htmlFor="staff-role" style={label}>{t('staff_role_label')}</label>
                    <select id="staff-role" value={form.role} onChange={(e) => setField('role', e.target.value)} style={input}>
                        <option value="reviewer">{t('staff_role_reviewer')}</option>
                        <option value="superadmin">{t('staff_role_admin')}</option>
                    </select>
                </div>
                {form.role === 'reviewer' && (
                    <div>
                        <label htmlFor="staff-programme" style={label}>{t('staff_programme_label')}</label>
                        <select id="staff-programme" value={form.programme_code} onChange={(e) => setField('programme_code', e.target.value)} style={input}>
                            <option value="">{t('staff_programme_choose')}</option>
                            {programmes.map((p) => <option key={p.code} value={p.code}>{programmeName(p, i18n)}</option>)}
                        </select>
                    </div>
                )}
                <div>
                    <label htmlFor="staff-language" style={label}>{t('staff_language_label')}</label>
                    <select id="staff-language" value={form.language} onChange={(e) => setField('language', e.target.value)} style={input}>
                        {LANGUAGES.map((code) => <option key={code} value={code}>{t(`staff_language_${code}`)}</option>)}
                    </select>
                </div>
                {form.role === 'reviewer' && (
                    <label style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <input type="checkbox" checked={form.replace} onChange={(e) => setField('replace', e.target.checked)} />
                        {t('staff_replace_label')}
                    </label>
                )}
                <button type="submit" disabled={sending} style={{ padding: '10px', backgroundColor: 'var(--brand)', color: 'var(--text-on-primary)', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: sending ? 'wait' : 'pointer' }}>
                    {t('staff_invite_button')}
                </button>
            </form>
            {formError && <p role="alert" style={{ color: 'var(--error-text)' }}>{formError}</p>}
            {created && (
                <div role="status" style={{ marginTop: '12px', padding: '10px', borderRadius: '6px', backgroundColor: 'var(--success-bg)', color: 'var(--success-text)', overflowWrap: 'anywhere' }}>
                    {t('staff_invite_sent', { email: created.email })}
                    <div style={{ fontSize: '13px', marginTop: '6px' }}>{t('staff_invite_link')} <code>{created.link}</code></div>
                </div>
            )}
            {actionError && <p role="alert" style={{ color: 'var(--error-text)' }}>{actionError}</p>}

            {/* Invites */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', justifyContent: 'space-between', marginTop: '24px' }}>
                <h3 style={{ margin: 0 }}>{t('staff_invites_title')}</h3>
                <label>
                    {t('staff_status_filter')}{' '}
                    <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ padding: '6px' }}>
                        <option value="">{t('staff_status_all')}</option>
                        {Object.keys(STATUS_CUES).map((status) => <option key={status} value={status}>{t(`staff_invite_status_${status}`)}</option>)}
                    </select>
                </label>
            </div>
            <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '8px' }}>
                    <thead>
                        <tr>
                            <th style={th}>{t('staff_email_label')}</th>
                            <th style={th}>{t('staff_role_label')}</th>
                            <th style={th}>{t('staff_programme_label')}</th>
                            <th style={th}>{t('staff_status_column')}</th>
                            <th style={th}>{t('staff_expires_column')}</th>
                            <th style={th}>{t('staff_actions_column')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {invites.length === 0 ? (
                            <tr><td colSpan="6" style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>{t('staff_no_invites')}</td></tr>
                        ) : invites.map((invite) => (
                            <tr key={invite.id}>
                                <td style={td}>{invite.email}{invite.replace && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('staff_replaces_reviewer')}</div>}</td>
                                <td style={td}>{roleName(invite.role)}</td>
                                <td style={td}>{invite.programme ? programmeName(invite.programme, i18n) : '—'}</td>
                                <td style={td}><Chip cue={STATUS_CUES[invite.status]}>{t(`staff_invite_status_${invite.status}`)}</Chip></td>
                                <td style={td}>{formatDate(invite.expires_at, language)}</td>
                                <td style={td}>
                                    {(invite.status === 'sent' || invite.status === 'expired') && (
                                        <>
                                            <button type="button" style={smallButton()} onClick={() => act(null, () => http.post(`users/invites/${invite.id}/resend`).json())}>{t('staff_resend')}</button>
                                            <button type="button" style={smallButton(true)} onClick={() => act(t('staff_confirm_cancel', { email: invite.email }), () => http.delete(`users/invites/${invite.id}`).json())}>{t('staff_cancel')}</button>
                                        </>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Reviewers */}
            <h3 style={{ marginTop: '24px' }}>{t('staff_reviewers_title')}</h3>
            <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr>
                            <th style={th}>{t('staff_programme_label')}</th>
                            <th style={th}>{t('staff_name_column')}</th>
                            <th style={th}>{t('staff_email_label')}</th>
                            <th style={th}>{t('staff_status_column')}</th>
                            <th style={th}>{t('staff_actions_column')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {reviewers.length === 0 ? (
                            <tr><td colSpan="5" style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>{t('staff_no_reviewers')}</td></tr>
                        ) : reviewers.map((person) => (
                            <tr key={person.id}>
                                <td style={td}>{person.programme ? programmeName(person.programme, i18n) : '—'}</td>
                                <td style={td}>{person.name}</td>
                                <td style={td}>{person.email}</td>
                                <td style={td}>{statusChip(person)}</td>
                                <td style={td}>
                                    {!person.deactivated_at && (
                                        <button type="button" style={smallButton(true)} onClick={() => act(t('staff_confirm_remove_reviewer', { name: person.name }), () => http.put(`users/${person.id}/remove-reviewer`).json())}>
                                            {t('staff_remove_reviewer')}
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Admins */}
            <h3 style={{ marginTop: '24px' }}>{t('staff_admins_title')}</h3>
            <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr>
                            <th style={th}>{t('staff_name_column')}</th>
                            <th style={th}>{t('staff_email_label')}</th>
                            <th style={th}>{t('staff_status_column')}</th>
                            <th style={th}>{t('staff_actions_column')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {admins.map((person) => (
                            <tr key={person.id}>
                                <td style={td}>{person.name}{person.is_self && ` (${t('staff_you')})`}</td>
                                <td style={td}>{person.email}</td>
                                <td style={td}>{statusChip(person)}</td>
                                <td style={td}>
                                    {/* Not yourself, not the last active admin (the server refuses both) */}
                                    {!person.deactivated_at && !person.is_self && activeAdmins > 1 && (
                                        <button type="button" style={smallButton(true)} onClick={() => act(t('staff_confirm_deactivate_admin', { name: person.name }), () => http.put(`users/${person.id}/deactivate-admin`).json())}>
                                            {t('staff_deactivate_admin')}
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
};

export default StaffAccess;
