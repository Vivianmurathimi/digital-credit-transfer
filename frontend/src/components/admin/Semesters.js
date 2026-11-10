import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage } from '../../errorMessage';
import { formatDateTime, formatDay, toBudapestInput } from '../../dates';
import { programmeName } from '../../programmeName';
import Chip from '../reviewer/Chip';
import { card, input, label, smallButton, td, th } from './adminStyles';

// Semesters (admin round Group 4): create and edit a semester (times in Budapest), and activate
// one (only one can be active; the next one waits in setup). Before activating, the warnings
// (programmes with no course or no reviewer) are shown in the confirmation; they don't block it.

const STATUS_CUES = { setup: 'pending', active: 'approved', closed: 'neutral' };
const EMPTY = { name: '', opens_at: '', closes_at: '', end_date: '', last_days: 3 };

// The active semester's period controls (admin round Group 5): Close now (with an optional reason
// for students) and Reopen until (a new closing time in the future). The server checks both.
const PeriodControls = ({ semester, onChange }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const [reason, setReason] = useState('');
    const [until, setUntil] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const isOpen = semester.started && !semester.period_over;
    const run = async (request, done) => {
        setError('');
        setNotice('');
        try {
            await request();
            setNotice(done);
            setReason('');
            setUntil('');
            onChange();
        } catch (err) { setError(getErrorMessage(err, t, 'period_action_failed')); }
    };
    const state = !semester.started ? t('period_admin_not_started', { date: formatDateTime(semester.opens_at, language) })
        : isOpen ? t('period_admin_open', { date: formatDateTime(semester.closes_at, language) })
            : semester.close_reason !== null ? t('period_admin_closed_by_admin', { date: formatDateTime(semester.closes_at, language) })
                : t('period_admin_closed', { date: formatDateTime(semester.closes_at, language) });
    return (
        <div style={{ marginTop: '15px', padding: '12px', backgroundColor: 'var(--surface-2)', borderRadius: '6px' }}>
            <h3 style={{ marginTop: 0 }}>{t('period_admin_title', { name: semester.name })}</h3>
            <p role="status" style={{ marginTop: 0, fontWeight: 'bold' }}>{state}</p>
            {semester.close_reason && <p style={{ marginTop: 0 }}>{t('period_admin_reason', { reason: semester.close_reason })}</p>}
            <p style={{ marginTop: 0, fontSize: '13px', color: 'var(--text-muted)' }}>{t('period_admin_last_days', { count: semester.last_days })}</p>
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
            {notice && <p role="status" style={{ color: 'var(--success-text)', fontWeight: 'bold' }}>{notice}</p>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px', alignItems: 'end' }}>
                {isOpen ? (
                    <form onSubmit={(e) => { e.preventDefault(); if (window.confirm(t('period_confirm_close'))) run(() => http.post(`admin/semesters/${semester.id}/close-now`, { json: { reason } }).json(), t('period_closed_done')); }}>
                        <label htmlFor="period-reason" style={label}>{t('period_reason_label')}</label>
                        <input id="period-reason" type="text" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} style={input} placeholder={t('period_reason_placeholder')} />
                        <button type="submit" style={{ ...smallButton(true), marginTop: '8px' }}>{t('period_close_now_button')}</button>
                    </form>
                ) : semester.started && (
                    <form onSubmit={(e) => { e.preventDefault(); run(() => http.post(`admin/semesters/${semester.id}/reopen`, { json: { until } }).json(), t('period_reopened_done')); }}>
                        <label htmlFor="period-until" style={label}>{t('period_reopen_label')}</label>
                        <input id="period-until" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} style={input} />
                        <button type="submit" disabled={!until} style={{ ...smallButton(), marginTop: '8px' }}>{t('period_reopen_button')}</button>
                    </form>
                )}
            </div>
        </div>
    );
};

// Closing the active semester (admin round Group 6), only after its last day. First the preview:
// how many pending and needs-info applications will be rejected, drafts deleted and late access
// ended, and that it can't be undone. The admin confirms by typing the semester name. After the
// close: the counts, the emails, and the PDF book, or its error with "Generate PDF again".
export const ClosePanel = ({ semester, onClosed }) => {
    const { t } = useTranslation();
    const [preview, setPreview] = useState(null);
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const loadPreview = async () => {
        setError('');
        try { setPreview((await http.get(`admin/semesters/${semester.id}/close-preview`).json()).preview); }
        catch (err) { setError(getErrorMessage(err, t, 'close_failed')); }
    };
    const close = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
            const { summary } = await http.post(`admin/semesters/${semester.id}/close`, { json: { confirm_name: typed }, timeout: 180000 }).json();
            onClosed({ id: semester.id, name: semester.name, ...summary });
        } catch (err) { setError(getErrorMessage(err, t, 'close_failed')); setBusy(false); }
    };

    return (
        <div style={{ marginTop: '15px', padding: '12px', borderRadius: '6px', backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)', border: '1px solid var(--orange)' }}>
            <h3 style={{ marginTop: 0 }}>{t('close_ready_title', { name: semester.name })}</h3>
            <p style={{ marginTop: 0 }}>{t('close_ready_intro')}</p>
            {!preview ? (
                <button type="button" onClick={loadPreview} style={smallButton(true)}>{t('close_button')}</button>
            ) : (
                <form onSubmit={close}>
                    <ul style={{ margin: '0 0 8px', paddingLeft: '18px' }}>
                        <li>{t('close_preview_pending', { count: preview.pending })}</li>
                        <li>{t('close_preview_needs_info', { count: preview.needsInfo })}</li>
                        <li>{t('close_preview_drafts', { count: preview.drafts })}</li>
                        <li>{t('close_preview_late', { count: preview.lateAccess })}</li>
                    </ul>
                    <p style={{ fontWeight: 'bold' }}>{t('close_cannot_undo')}</p>
                    <label htmlFor="close-name" style={label}>{t('close_type_name', { name: semester.name })}</label>
                    <input id="close-name" type="text" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} style={{ ...input, maxWidth: '320px' }} />
                    <div style={{ marginTop: '8px' }}>
                        <button type="submit" disabled={busy || typed.trim() !== semester.name} style={smallButton(true)}>{t('close_confirm_button')}</button>
                        <button type="button" onClick={() => { setPreview(null); setTyped(''); }} style={smallButton()}>{t('staff_cancel')}</button>
                    </div>
                </form>
            )}
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
        </div>
    );
};

// The result of a close: counts, emails, and the PDF book or its error with "Generate PDF again"
export const CloseResult = ({ result, onBookGenerated }) => {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const regenerate = async () => {
        setBusy(true);
        setError('');
        try {
            await http.post(`admin/past-semesters/${result.id}/book`, { timeout: 180000 }).json();
            onBookGenerated();
        } catch (err) { setError(getErrorMessage(err, t, 'close_book_failed')); }
        finally { setBusy(false); }
    };
    return (
        <div role="status" style={{ marginTop: '15px', padding: '12px', borderRadius: '6px', backgroundColor: 'var(--success-bg)', color: 'var(--success-text)' }}>
            <strong>{t('close_done', { name: result.name })}</strong>
            <div>{t('close_done_counts', { rejected: result.rejected, emails: result.emailsSent, drafts: result.drafts, late: result.lateAccess })}</div>
            {result.book?.error ? (
                <div style={{ marginTop: '8px', color: 'var(--danger-text)' }}>
                    {t('close_book_error', { error: result.book.error })}{' '}
                    <button type="button" disabled={busy} onClick={regenerate} style={smallButton()}>{t('close_book_again')}</button>
                </div>
            ) : <div>{t('close_book_ok')}</div>}
            <div style={{ marginTop: '6px' }}><Link to="/admin/past-semesters" style={{ color: 'inherit', fontWeight: 'bold' }}>{t('close_go_past')}</Link></div>
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
        </div>
    );
};

const Semesters = ({ semesters, onChange }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const [form, setForm] = useState(null); // { id?, name, opens_at, closes_at, end_date } while editing
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [closeResult, setCloseResult] = useState(null); // the last close, shown after the list reloads

    const edit = (semester) => {
        setError('');
        setNotice('');
        setForm(semester
            ? { id: semester.id, name: semester.name, opens_at: toBudapestInput(semester.opens_at), closes_at: toBudapestInput(semester.closes_at), end_date: semester.end_date, last_days: semester.last_days }
            : EMPTY);
    };

    const save = async (e) => {
        e.preventDefault();
        setError('');
        const { id, ...fields } = form;
        const json = { ...fields, last_days: Number(fields.last_days) };
        try {
            if (id) await http.put(`admin/semesters/${id}`, { json }).json();
            else await http.post('admin/semesters', { json }).json();
            setForm(null);
            setNotice(t('semesters_saved'));
            onChange();
        } catch (err) { setError(getErrorMessage(err, t, 'semesters_save_failed')); }
    };

    const activate = async (semester) => {
        setError('');
        setNotice('');
        try {
            const { warnings } = await http.get(`admin/semesters/${semester.id}/warnings`).json();
            const lines = warnings.map((w) => `• ${programmeName(w, i18n)}: ${[w.no_courses && t('semesters_warning_no_courses'), w.no_reviewer && t('semesters_warning_no_reviewer')].filter(Boolean).join(', ')}`);
            const text = [t('semesters_confirm_activate', { name: semester.name }), lines.length ? `${t('semesters_warnings_title')}\n${lines.join('\n')}` : ''].filter(Boolean).join('\n\n');
            if (!window.confirm(text)) return;
            await http.post(`admin/semesters/${semester.id}/activate`).json();
            setNotice(t('semesters_activated', { name: semester.name }));
            onChange();
        } catch (err) { setError(getErrorMessage(err, t, 'semesters_activate_failed')); }
    };

    const field = (key, type, labelKey) => (
        <div>
            <label htmlFor={`semester-${key}`} style={label}>{t(labelKey)}</label>
            <input id={`semester-${key}`} type={type} value={form[key]} maxLength={type === 'text' ? 50 : undefined}
                onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))} style={input} />
        </div>
    );

    return (
        <section aria-labelledby="semesters-title" style={card}>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                <h2 id="semesters-title" style={{ margin: 0, color: 'var(--heading)' }}>{t('semesters_title')}</h2>
                {!form && <button type="button" onClick={() => edit(null)} style={smallButton()}>{t('semesters_new_button')}</button>}
            </div>
            <p style={{ color: 'var(--text-muted)' }}>{t('semesters_intro')}</p>
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
            {notice && <p role="status" style={{ color: 'var(--success-text)', fontWeight: 'bold' }}>{notice}</p>}

            {form && (
                <form onSubmit={save} noValidate style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', alignItems: 'end', marginBottom: '15px', padding: '12px', backgroundColor: 'var(--surface-2)', borderRadius: '6px' }}>
                    {field('name', 'text', 'semesters_name_label')}
                    {field('opens_at', 'datetime-local', 'semesters_opens_label')}
                    {field('closes_at', 'datetime-local', 'semesters_closes_label')}
                    {field('end_date', 'date', 'semesters_end_label')}
                    {field('last_days', 'number', 'semesters_last_days_label')}
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button type="submit" style={{ ...smallButton(), backgroundColor: 'var(--brand)', color: 'var(--text-on-primary)', border: 'none' }}>{t('semesters_save_button')}</button>
                        <button type="button" onClick={() => setForm(null)} style={smallButton()}>{t('staff_cancel')}</button>
                    </div>
                    <p style={{ gridColumn: '1 / -1', margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>{t('semesters_time_hint')}</p>
                </form>
            )}

            <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr>
                            <th style={th}>{t('semesters_name_label')}</th>
                            <th style={th}>{t('staff_status_column')}</th>
                            <th style={th}>{t('semesters_opens_label')}</th>
                            <th style={th}>{t('semesters_closes_label')}</th>
                            <th style={th}>{t('semesters_end_label')}</th>
                            <th style={th}>{t('semesters_counts_column')}</th>
                            <th style={th}>{t('staff_actions_column')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {semesters.length === 0 ? (
                            <tr><td colSpan="7" style={{ ...td, color: 'var(--text-muted)', textAlign: 'center' }}>{t('semesters_none')}</td></tr>
                        ) : semesters.map((s) => (
                            <tr key={s.id}>
                                <td style={td}>{s.name}</td>
                                <td style={td}><Chip cue={STATUS_CUES[s.status]}>{t(`semesters_status_${s.status}`)}</Chip></td>
                                <td style={td}>{formatDateTime(s.opens_at, language)}</td>
                                <td style={td}>{formatDateTime(s.closes_at, language)}</td>
                                <td style={td}>{formatDay(s.end_date, language)}</td>
                                <td style={td}>{t('semesters_counts', { courses: s.courses, applications: s.applications })}</td>
                                <td style={td}>
                                    {s.status !== 'closed' && <button type="button" onClick={() => edit(s)} style={smallButton()}>{t('semesters_edit_button')}</button>}
                                    {s.status === 'setup' && <button type="button" onClick={() => activate(s)} style={smallButton()}>{t('semesters_activate_button')}</button>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {closeResult && <CloseResult result={closeResult} onBookGenerated={() => setCloseResult((r) => ({ ...r, book: { name: 'ok' } }))} />}
            {/* The active semester's application period (admin round Group 5) */}
            {semesters.filter((s) => s.status === 'active').map((s) => (
                <React.Fragment key={s.id}>
                    <PeriodControls semester={s} onChange={onChange} />
                    {/* After its last day: "Ready to close" (admin round Group 6) */}
                    {s.ended && <ClosePanel semester={s} onClosed={(result) => { setCloseResult(result); onChange(); }} />}
                </React.Fragment>
            ))}
        </section>
    );
};

export default Semesters;
