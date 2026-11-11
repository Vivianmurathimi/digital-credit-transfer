import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage, unpackBlobError } from '../../errorMessage';
import { programmeName } from '../../programmeName';
import { card, input, label, smallButton, td, th } from './adminStyles';

// Analytics (admin round Group 7): how a semester went, calculated on the server. The active semester
// by default, closed ones selectable. Plain tables with simple bars (HTML only, no chart library),
// each table exportable as CSV. "Time to decision" runs from submission to the final decision of a
// reviewer or an admin (System auto-rejections left out); it is shown again without the time spent
// waiting for the student's reply.

const STATUSES = ['pending', 'needs_info', 'approved', 'rejected', 'withdrawn'];
const STATUS_CUES = { pending: 'pending', needs_info: 'needs-info', approved: 'approved', rejected: 'rejected', withdrawn: 'neutral' };

// A bar whose length is the value's share of the largest one
const Bar = ({ value, max, cue = 'pending', text }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '160px' }}>
        <div aria-hidden="true" style={{ flex: '1 1 auto', height: '12px', backgroundColor: 'var(--surface-2)', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
            <div style={{ width: `${max > 0 ? Math.round((value / max) * 100) : 0}%`, height: '100%', backgroundColor: `var(--cue-${cue}-border)` }} />
        </div>
        <span style={{ minWidth: '44px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{text ?? value}</span>
    </div>
);

const Analytics = () => {
    const { t, i18n } = useTranslation();
    const language = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2);
    const [semesterId, setSemesterId] = useState('');
    const [data, setData] = useState(null); // { semesters, semester, analytics }
    const [error, setError] = useState('');

    const load = useCallback(async (id) => {
        setError('');
        try {
            setData(await http.get('admin/analytics', { searchParams: id ? { semester_id: id } : {} }).json());
        } catch (err) { setError(getErrorMessage(err, t, 'analytics_load_failed')); }
    }, [t]);
    useEffect(() => { load(semesterId); }, [load, semesterId]);

    const exportCsv = async (table) => {
        setError('');
        try {
            const blob = await http.get('admin/analytics/export.csv', { searchParams: { semester_id: data.semester.id, table, lang: language } }).blob();
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `analytics-${table}-${data.semester.name}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.URL.revokeObjectURL(url);
        } catch (err) { setError(getErrorMessage(await unpackBlobError(err), t, 'analytics_export_failed')); }
    };
    const exportButton = (table) => <button type="button" onClick={() => exportCsv(table)} style={smallButton()}>{t('past_export_csv')}</button>;
    const days = (value) => (value === null || value === undefined ? '—' : t('analytics_days', { value: value.toLocaleString(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }));
    const nameOf = (programme) => (programme ? `${programme.code} – ${programmeName(programme, i18n)}` : t('analytics_all_programmes'));

    const a = data?.analytics;
    const maxStatus = a ? Math.max(0, ...STATUSES.map((s) => a.status.overall[s])) : 0;
    const turnRows = a ? [...a.turnaround.byProgramme, a.turnaround.overall] : [];
    const maxDays = Math.max(0, ...turnRows.map((r) => r.averageDays || 0));
    const maxCourse = a ? Math.max(0, ...a.topCourses.map((c) => c.applications)) : 0;

    const sectionHead = (titleKey, table) => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', justifyContent: 'space-between', marginTop: '22px' }}>
            <h3 style={{ margin: 0 }}>{t(titleKey)}</h3>
            {exportButton(table)}
        </div>
    );

    return (
        <section aria-labelledby="analytics-title" style={card}>
            <h2 id="analytics-title" style={{ marginTop: 0, color: 'var(--heading)' }}>{t('admin_menu_analytics')}</h2>
            <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{t('analytics_intro')}</p>
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
            {data && data.semesters.length === 0 && <p>{t('analytics_no_semester')}</p>}
            {data && data.semesters.length > 0 && (
                <div style={{ maxWidth: '360px' }}>
                    <label htmlFor="analytics-semester" style={label}>{t('import_semester_label')}</label>
                    <select id="analytics-semester" value={semesterId || String(data.semester?.id || '')} onChange={(e) => setSemesterId(e.target.value)} style={input}>
                        {data.semesters.map((s) => <option key={s.id} value={s.id}>{s.name} ({t(`semesters_status_${s.status}`)})</option>)}
                    </select>
                </div>
            )}

            {a && (
                <>
                    {sectionHead('analytics_status_title', 'status')}
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '6px' }}>
                            <thead><tr><th style={th}>{t('staff_status_column')}</th><th style={th}>{t('analytics_applications_column')}</th></tr></thead>
                            <tbody>
                                {STATUSES.map((s) => (
                                    <tr key={s}><td style={td}>{t(`status_${s}`)}</td><td style={td}><Bar value={a.status.overall[s]} max={maxStatus} cue={STATUS_CUES[s]} /></td></tr>
                                ))}
                                <tr><td style={{ ...td, fontWeight: 'bold' }}>{t('analytics_total')}</td><td style={{ ...td, fontWeight: 'bold' }}>{a.status.overall.total}</td></tr>
                            </tbody>
                        </table>
                    </div>

                    {sectionHead('analytics_programmes_title', 'programmes')}
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '6px' }}>
                            <thead><tr><th style={th}>{t('staff_programme_label')}</th>{STATUSES.map((s) => <th key={s} style={th}>{t(`status_${s}`)}</th>)}<th style={th}>{t('analytics_total')}</th></tr></thead>
                            <tbody>
                                {a.status.byProgramme.length === 0 ? (
                                    <tr><td colSpan={STATUSES.length + 2} style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>{t('analytics_none')}</td></tr>
                                ) : a.status.byProgramme.map((r) => (
                                    <tr key={r.programme.code}>
                                        <td style={td}>{nameOf(r.programme)}</td>
                                        {STATUSES.map((s) => <td key={s} style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{r[s]}</td>)}
                                        <td style={{ ...td, fontWeight: 'bold' }}>{r.total}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {sectionHead('analytics_turnaround_title', 'turnaround')}
                    <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>{t('analytics_turnaround_hint')}</p>
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '6px' }}>
                            <thead>
                                <tr>
                                    <th style={th}>{t('staff_programme_label')}</th>
                                    <th style={th}>{t('analytics_decided_column')}</th>
                                    <th style={th}>{t('analytics_average_column')}</th>
                                    <th style={th}>{t('analytics_median_column')}</th>
                                    <th style={th}>{t('analytics_average_without_column')}</th>
                                    <th style={th}>{t('analytics_median_without_column')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {turnRows.map((r) => (
                                    <tr key={r.programme ? r.programme.code : 'all'} style={r.programme ? undefined : { fontWeight: 'bold' }}>
                                        <td style={td}>{nameOf(r.programme)}</td>
                                        <td style={td}>{r.decided}</td>
                                        <td style={td}><Bar value={r.averageDays || 0} max={maxDays} text={days(r.averageDays)} /></td>
                                        <td style={td}>{days(r.medianDays)}</td>
                                        <td style={td}>{days(r.averageDaysWithoutWaiting)}</td>
                                        <td style={td}>{days(r.medianDaysWithoutWaiting)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {sectionHead('analytics_courses_title', 'courses')}
                    <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>{t('analytics_courses_hint')}</p>
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '6px' }}>
                            <thead><tr><th style={th}>#</th><th style={th}>{t('staff_programme_label')}</th><th style={th}>{t('catalogue_course_column')}</th><th style={th}>{t('analytics_applications_column')}</th></tr></thead>
                            <tbody>
                                {a.topCourses.length === 0 ? (
                                    <tr><td colSpan="4" style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>{t('analytics_none')}</td></tr>
                                ) : a.topCourses.map((c, i) => (
                                    <tr key={`${c.programme.code}-${c.courseCode}`}>
                                        <td style={td}>{i + 1}</td>
                                        <td style={td}>{c.programme.code}</td>
                                        <td style={td}>{c.courseCode}{c.courseName ? ` – ${c.courseName}` : ''}</td>
                                        <td style={td}><Bar value={c.applications} max={maxCourse} /></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </section>
    );
};

export default Analytics;
