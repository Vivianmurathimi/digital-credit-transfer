import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage } from '../../errorMessage';
import { formatDateTime } from '../../dates';
import Chip from '../reviewer/Chip';
import { card, input, label, smallButton, td, th } from './adminStyles';
import ReviewDeadlineMove, { reviewSituation, suggestedReviewEnd } from './ReviewDeadlineMove';

// Late access (admin round Group 5; round 2 Group 1): one or more student email addresses and a
// deadline, for one semester in progress (chosen here when several are). Those students can
// register and submit into that semester until their deadline, also after its period closed. The
// deadline may run up to the semester's review deadline; a later or tight one offers to move the
// review deadline in the same step. Each address is checked on its own (format, allowed domain, not
// a staff account); they get an email. Revoking takes effect at once.

const STATUS_CUES = { active: 'approved', expired: 'needs-info', revoked: 'neutral' };
const LANGUAGES = ['hu', 'en', 'de'];

const LateAccess = ({ onChange = () => {} }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const [data, setData] = useState(null); // { semesters, semester, grants, reviewMarginDays }
    const [semesterId, setSemesterId] = useState(''); // '' = the server's default
    const [reviewMove, setReviewMove] = useState('');
    const [emails, setEmails] = useState('');
    const [deadline, setDeadline] = useState('');
    const [emailLanguage, setEmailLanguage] = useState('hu');
    const [results, setResults] = useState(null);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        try { setData(await http.get('admin/late-access', { searchParams: semesterId ? { semester_id: semesterId } : {} }).json()); }
        catch (err) { setError(getErrorMessage(err, t, 'late_load_failed')); }
    }, [t, semesterId]);
    const margin = data?.reviewMarginDays;
    const chooseDeadline = (value) => {
        setDeadline(value);
        setReviewMove(reviewSituation(value, data?.semester?.review_end_at, margin) ? suggestedReviewEnd(value, margin) : '');
    };
    useEffect(() => { load(); }, [load]);

    const grant = async (e) => {
        e.preventDefault();
        setError('');
        setResults(null);
        try {
            const json = { emails, deadline, language: emailLanguage, semester_id: data.semester.id, ...(reviewMove ? { review_end_at: reviewMove } : {}) };
            const body = await http.post('admin/late-access', { json }).json();
            setReviewMove('');
            setResults(body.results);
            if (body.results.some((r) => r.ok)) setEmails(body.results.filter((r) => !r.ok).map((r) => r.email).join(', '));
            load();
            onChange();
        } catch (err) { setError(getErrorMessage(err, t, 'late_grant_failed')); }
    };

    const revoke = async (row) => {
        if (!window.confirm(t('late_confirm_revoke', { email: row.email }))) return;
        setError('');
        try { await http.delete(`admin/late-access/${row.id}`).json(); } catch (err) { setError(getErrorMessage(err, t, 'late_revoke_failed')); }
        load();
        onChange();
    };

    if (data && !data.semester) {
        return <section style={card}><h2 style={{ marginTop: 0, color: 'var(--heading)' }}>{t('late_title')}</h2><p>{t('late_no_semester')}</p></section>;
    }

    return (
        <section aria-labelledby="late-title" style={card}>
            <h2 id="late-title" style={{ marginTop: 0, color: 'var(--heading)' }}>{t('late_title')}</h2>
            <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{t('late_intro', { name: data?.semester?.name || '' })}</p>
            {(data?.semesters || []).length > 1 && (
                <div style={{ maxWidth: '360px', marginBottom: '10px' }}>
                    <label htmlFor="late-semester" style={label}>{t('import_semester_label')}</label>
                    <select id="late-semester" value={semesterId || String(data.semester?.id || '')} onChange={(e) => { setSemesterId(e.target.value); setReviewMove(''); setResults(null); }} style={input}>
                        {data.semesters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                </div>
            )}
            {data?.semester && <p style={{ marginTop: 0, fontSize: '13px' }}>{t('late_review_deadline', { date: formatDateTime(data.semester.review_end_at, language) })}</p>}
            <form onSubmit={grant} noValidate style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', alignItems: 'end' }}>
                <div style={{ gridColumn: '1 / -1' }}>
                    <label htmlFor="late-emails" style={label}>{t('late_emails_label')}</label>
                    <textarea id="late-emails" value={emails} rows={3} onChange={(e) => setEmails(e.target.value)} style={input} placeholder={t('late_emails_placeholder')} />
                </div>
                <div>
                    <label htmlFor="late-deadline" style={label}>{t('late_deadline_label')}</label>
                    <input id="late-deadline" type="datetime-local" value={deadline} onChange={(e) => chooseDeadline(e.target.value)} style={input} />
                </div>
                <ReviewDeadlineMove id="late-review" newEnd={deadline} reviewEndAt={data?.semester?.review_end_at} margin={margin} value={reviewMove} onChange={setReviewMove} />
                <div>
                    <label htmlFor="late-language" style={label}>{t('staff_language_label')}</label>
                    <select id="late-language" value={emailLanguage} onChange={(e) => setEmailLanguage(e.target.value)} style={input}>
                        {LANGUAGES.map((code) => <option key={code} value={code}>{t(`staff_language_${code}`)}</option>)}
                    </select>
                </div>
                <button type="submit" disabled={!emails.trim() || !deadline} style={{ ...smallButton(), padding: '9px 14px', backgroundColor: 'var(--brand)', color: 'var(--text-on-primary)', border: 'none' }}>{t('late_grant_button')}</button>
                <p style={{ gridColumn: '1 / -1', margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>{t('late_language_hint')}</p>
            </form>
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
            {results && (
                <ul role="status" style={{ paddingLeft: '18px' }}>
                    {results.map((r) => (
                        <li key={r.email} style={{ color: r.ok ? 'var(--success-text)' : 'var(--error-text)' }}>
                            {r.email}: {r.ok ? t('late_granted') : t(`errors.${r.code}`)}
                        </li>
                    ))}
                </ul>
            )}

            <div style={{ overflowX: 'auto', marginTop: '12px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr>
                            <th style={th}>{t('staff_email_label')}</th>
                            <th style={th}>{t('late_deadline_label')}</th>
                            <th style={th}>{t('staff_status_column')}</th>
                            <th style={th}>{t('late_granted_by_column')}</th>
                            <th style={th}>{t('staff_actions_column')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {(data?.grants || []).length === 0 ? (
                            <tr><td colSpan="5" style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>{t('late_none')}</td></tr>
                        ) : data.grants.map((g) => (
                            <tr key={g.id}>
                                <td style={td}>{g.email}{!g.registered && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('late_not_registered')}</div>}</td>
                                <td style={td}>{formatDateTime(g.deadline, language)}</td>
                                <td style={td}><Chip cue={STATUS_CUES[g.status]}>{t(`late_status_${g.status}`)}</Chip></td>
                                <td style={td}>{g.granted_by_name || '—'}</td>
                                <td style={td}>{g.status === 'active' && <button type="button" onClick={() => revoke(g)} style={smallButton(true)}>{t('late_revoke_button')}</button>}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
};

export default LateAccess;
