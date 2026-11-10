import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage, unpackBlobError } from '../../errorMessage';
import { formatDate, formatDateTime } from '../../dates';
import ApplicationDetails from '../reviewer/ApplicationDetails';
import TermArchive from '../TermArchive';
import { card, input, label, smallButton, td, th } from './adminStyles';

// Past semesters (admin round Group 6): pick a closed semester, search its applications by
// student name, email, Neptun code or course, filter by status, open one read-only, export the
// results as CSV and download (or generate again) the semester's PDF book. Below: the date-range
// term book (moved here from Applications). Nothing here changes an application: a closed semester
// is read-only on the server for everyone.

const STATUSES = ['pending', 'needs_info', 'approved', 'rejected', 'withdrawn'];

// The routes need the login token, so the file is fetched and saved from the browser
const saveBlob = (blob, fileName) => {
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
};

const PastSemesters = () => {
    const { t, i18n } = useTranslation();
    const language = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2);
    const [semesters, setSemesters] = useState(null);
    const [semesterId, setSemesterId] = useState('');
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState('');
    const [results, setResults] = useState(null); // { total, applications }
    const [openId, setOpenId] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const loadSemesters = useCallback(async () => {
        try {
            const list = (await http.get('admin/past-semesters').json()).semesters;
            setSemesters(list);
            setSemesterId((current) => current || (list[0] ? String(list[0].id) : ''));
        } catch (err) { setError(getErrorMessage(err, t, 'past_load_failed')); }
    }, [t]);
    useEffect(() => { loadSemesters(); }, [loadSemesters]);

    const params = useCallback((extra = {}) => ({ ...(query.trim() ? { q: query.trim() } : {}), ...(status ? { status } : {}), ...extra }), [query, status]);

    const search = useCallback(async (offset = 0) => {
        if (!semesterId) return;
        setError('');
        try {
            const data = await http.get(`admin/past-semesters/${semesterId}/applications`, { searchParams: params({ offset }) }).json();
            setResults((prev) => (offset > 0 && prev ? { ...data, applications: [...prev.applications, ...data.applications] } : data));
        } catch (err) { setError(getErrorMessage(err, t, 'past_search_failed')); }
    }, [semesterId, params, t]);
    useEffect(() => { setResults(null); setOpenId(null); search(0); }, [semesterId]); // eslint-disable-line react-hooks/exhaustive-deps

    const semester = (semesters || []).find((s) => String(s.id) === semesterId);

    const download = async (path, fileName, searchParams) => {
        setError('');
        try {
            saveBlob(await http.get(path, { searchParams, timeout: 120000 }).blob(), fileName);
        } catch (err) { setError(getErrorMessage(await unpackBlobError(err), t, 'past_download_failed')); }
    };
    const regenerate = async () => {
        setBusy(true);
        setError('');
        try {
            await http.post(`admin/past-semesters/${semesterId}/book`, { timeout: 180000 }).json();
            await loadSemesters();
        } catch (err) { setError(getErrorMessage(err, t, 'close_book_failed')); }
        finally { setBusy(false); }
    };

    const decidedBy = (a) => (a.decided_by_role === 'reviewer' ? a.decided_by_name : a.decided_by_role ? t(`reviewer_decided_by_${a.decided_by_role}`) : '—');

    return (
        <>
            <section aria-labelledby="past-title" style={card}>
                <h2 id="past-title" style={{ marginTop: 0, color: 'var(--heading)' }}>{t('admin_menu_past_semesters')}</h2>
                <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{t('past_intro')}</p>
                {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
                {semesters && semesters.length === 0 && <p>{t('past_none')}</p>}

                {semesters && semesters.length > 0 && (
                    <>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', alignItems: 'end' }}>
                            <div>
                                <label htmlFor="past-semester" style={label}>{t('import_semester_label')}</label>
                                <select id="past-semester" value={semesterId} onChange={(e) => setSemesterId(e.target.value)} style={input}>
                                    {semesters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                                </select>
                            </div>
                        </div>
                        {semester && (
                            <div style={{ marginTop: '10px', padding: '10px', borderRadius: '6px', backgroundColor: 'var(--surface-2)' }}>
                                <div>{t('past_semester_info', { date: formatDateTime(semester.closed_at, language), name: semester.closed_by_name || t('reviewer_decided_by_system'), count: semester.applications })}</div>
                                <div style={{ marginTop: '6px' }}>
                                    {semester.has_book && (
                                        <button type="button" style={smallButton()} onClick={() => download(`admin/past-semesters/${semester.id}/book`, `${semester.name}.pdf`)}>
                                            {t('past_download_book')}
                                        </button>
                                    )}
                                    <button type="button" disabled={busy} style={smallButton()} onClick={regenerate}>{t(semester.has_book ? 'past_regenerate_book' : 'close_book_again')}</button>
                                    {semester.book_error && <span role="alert" style={{ color: 'var(--error-text)' }}>{t('close_book_error', { error: semester.book_error })}</span>}
                                </div>
                            </div>
                        )}

                        <form onSubmit={(e) => { e.preventDefault(); setOpenId(null); search(0); }} role="search" style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'end', marginTop: '12px' }}>
                            <div style={{ flex: '1 1 260px' }}>
                                <label htmlFor="past-q" style={label}>{t('past_search_label')}</label>
                                <input id="past-q" type="search" value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)} style={input} />
                            </div>
                            <div>
                                <label htmlFor="past-status" style={label}>{t('staff_status_column')}</label>
                                <select id="past-status" value={status} onChange={(e) => setStatus(e.target.value)} style={input}>
                                    <option value="">{t('staff_status_all')}</option>
                                    {STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
                                </select>
                            </div>
                            <button type="submit" style={{ ...smallButton(), padding: '9px 14px', backgroundColor: 'var(--brand)', color: 'var(--text-on-primary)', border: 'none' }}>{t('students_search_button')}</button>
                            <button type="button" style={{ ...smallButton(), padding: '9px 14px' }}
                                onClick={() => download(`admin/past-semesters/${semesterId}/export.csv`, `${semester?.name || 'applications'}.csv`, params({ lang: language }))}>
                                {t('past_export_csv')}
                            </button>
                        </form>

                        {results && (
                            <>
                                <p role="status" style={{ marginBottom: '6px' }}>{t('past_results', { count: results.total })}</p>
                                <div style={{ overflowX: 'auto' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                        <thead>
                                            <tr>
                                                <th style={th}>{t('staff_name_column')}</th>
                                                <th style={th}>{t('students_neptun_column')}</th>
                                                <th style={th}>{t('catalogue_course_column')}</th>
                                                <th style={th}>{t('staff_status_column')}</th>
                                                <th style={th}>{t('superadmin_decided_by_column')}</th>
                                                <th style={th}>{t('past_submitted_column')}</th>
                                                <th style={th}>{t('staff_actions_column')}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {results.applications.length === 0 ? (
                                                <tr><td colSpan="7" style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>{t('past_no_results')}</td></tr>
                                            ) : results.applications.map((a) => (
                                                <React.Fragment key={a.id}>
                                                    <tr>
                                                        <td style={td}>{a.student_name}<div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{a.student_email}</div></td>
                                                        <td style={td}>{a.neptun_code}</td>
                                                        <td style={td}>{a.target_course_code}{a.target_course_name ? ` – ${a.target_course_name}` : ''}</td>
                                                        <td style={td}>{t(`status_${a.status}`)}{a.final_grade ? ` (${a.final_grade})` : ''}</td>
                                                        <td style={td}>{decidedBy(a)}{a.decided_at ? <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{formatDate(a.decided_at, language)}</div> : null}</td>
                                                        <td style={td}>{formatDate(a.submitted_at, language)}</td>
                                                        <td style={td}>
                                                            <button type="button" aria-expanded={openId === a.id} onClick={() => setOpenId(openId === a.id ? null : a.id)} style={smallButton()}>
                                                                {t(openId === a.id ? 'past_close_details' : 'past_open_details')}
                                                            </button>
                                                        </td>
                                                    </tr>
                                                    {openId === a.id && (
                                                        <tr><td colSpan="7" style={{ ...td, backgroundColor: 'var(--surface-2)' }}>
                                                            <ApplicationDetails appId={a.id} readOnly url={`admin/past-semesters/${semesterId}/applications/${a.id}`} />
                                                        </td></tr>
                                                    )}
                                                </React.Fragment>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                {results.applications.length < results.total && (
                                    <button type="button" onClick={() => search(results.applications.length)} style={{ ...smallButton(), marginTop: '8px' }}>{t('past_load_more')}</button>
                                )}
                            </>
                        )}
                    </>
                )}
            </section>

            {/* The term book for any date range (moved here from Applications) */}
            <TermArchive />
        </>
    );
};

export default PastSemesters;
