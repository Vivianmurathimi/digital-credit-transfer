import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage } from '../../errorMessage';
import { programmeName } from '../../programmeName';
import Chip from '../reviewer/Chip';
import ConfirmModal from '../ConfirmModal';
import ListSearch from './ListSearch';
import { courseMatches, programmeMatches } from '../../searchText';
import { card, disabledButton, input, label, smallButton, td, th } from './adminStyles';

// Programmes & Courses (admin round Group 4): every programme and the chosen semester's courses,
// with status and how many students and applications use each. Hide and Show at any time (Hide
// keeps all data); Delete only when nothing uses the item, otherwise greyed out with the reason.
// Fixes 1b: a programme shows the other codes the import treats as it ("Also imported as: CIVIL").
// Confirmations are in-app (ConfirmModal).
// Fixes 3a: a search box above each table, filtering as you type (case and accents ignored):
// programmes by code, other codes and names (every language), courses by code or name. The courses
// are the chosen semester's only; the typed text stays when the semester changes.

const Catalogue = ({ semesters, reloadKey, onChange = () => {} }) => {
    const { t, i18n } = useTranslation();
    const [semesterId, setSemesterId] = useState('');
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [confirming, setConfirming] = useState(null); // { text, confirmLabel, danger, run }
    const [busy, setBusy] = useState(false);
    const [programmeQuery, setProgrammeQuery] = useState('');
    const [courseQuery, setCourseQuery] = useState('');

    // Start with the active semester
    useEffect(() => {
        if (!semesterId && semesters.length) setSemesterId(String((semesters.find((s) => s.status === 'active') || semesters[0]).id));
    }, [semesters, semesterId]);

    const load = useCallback(async () => {
        if (!semesterId) return;
        try {
            setData(await http.get('admin/catalogue', { searchParams: { semester_id: semesterId } }).json());
            setError('');
        } catch (err) { setError(getErrorMessage(err, t, 'catalogue_load_failed')); }
    }, [semesterId, t]);
    useEffect(() => { load(); }, [load, reloadKey]);

    const run = async (request, onDone) => {
        setError('');
        setNotice('');
        try {
            const result = await request();
            if (onDone) onDone(result);
        } catch (err) {
            setError(getErrorMessage(err, t, 'catalogue_action_failed'));
        }
        load();
        onChange();
    };
    // confirm: a text, or { text, confirmLabel, danger }, asked in the in-app dialog first
    const act = (confirm, request, onDone) => {
        if (!confirm) return run(request, onDone);
        const ask = typeof confirm === 'string' ? { text: confirm } : confirm;
        setConfirming({ title: t('confirm_title'), ...ask, run: () => run(request, onDone) });
        return undefined;
    };
    const confirmNow = async () => {
        setBusy(true);
        try { await confirming.run(); } finally { setBusy(false); setConfirming(null); }
    };
    const shownProgrammes = data ? data.programmes.filter((p) => programmeMatches(programmeQuery, p)) : [];
    const shownCourses = data ? data.courses.filter((c) => courseMatches(courseQuery, c)) : [];
    const noMatches = <p role="status" style={{ color: 'var(--text-muted)', margin: '8px 0' }}>{t('list_search_no_matches')}</p>;
    const reasonText = (reasons) => reasons.map((r) => t(`catalogue_blocked_${r}`)).join(' ');
    const statusChip = (status) => <Chip cue={status === 'active' ? 'approved' : 'neutral'}>{t(`catalogue_status_${status}`)}</Chip>;
    const toggle = (kind, item) => {
        const next = item.status === 'active' ? 'hidden' : 'active';
        return (
            <button type="button" style={smallButton()} onClick={() => act(null, () => http.put(`admin/${kind}/${item.id}/status`, { json: { status: next } }).json())}>
                {t(next === 'hidden' ? 'catalogue_hide' : 'catalogue_show')}
            </button>
        );
    };
    const remove = (kind, item, name) => (
        <span title={item.canDelete ? '' : reasonText(item.blockedBy)} style={{ display: 'inline-block' }}>
            <button
                type="button" disabled={!item.canDelete} aria-disabled={!item.canDelete}
                aria-label={item.canDelete ? t('catalogue_delete_label', { name }) : `${t('catalogue_delete_label', { name })} – ${reasonText(item.blockedBy)}`}
                style={{ ...smallButton(true), ...(item.canDelete ? {} : disabledButton) }}
                onClick={() => act(t('catalogue_confirm_delete', { name }), () => http.delete(`admin/${kind}/${item.id}`, { searchParams: { semester_id: semesterId } }).json())}
            >
                {t('catalogue_delete')}
            </button>
        </span>
    );

    return (
        <section aria-labelledby="catalogue-title" style={card}>
            <h2 id="catalogue-title" style={{ marginTop: 0, color: 'var(--heading)' }}>{t('catalogue_title')}</h2>
            <div style={{ maxWidth: '320px', marginBottom: '12px' }}>
                <label htmlFor="catalogue-semester" style={label}>{t('import_semester_label')}</label>
                <select id="catalogue-semester" value={semesterId} onChange={(e) => setSemesterId(e.target.value)} style={input}>
                    {semesters.map((s) => <option key={s.id} value={s.id}>{s.name} ({t(`semesters_status_${s.status}`)})</option>)}
                </select>
            </div>
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
            {notice && <p role="status" style={{ color: 'var(--success-text)', fontWeight: 'bold' }}>{notice}</p>}

            {data && (
                <>
                    <h3>{t('catalogue_programmes')}</h3>
                    <ListSearch id="catalogue-programme-search" label={t('catalogue_search_programmes')} placeholder={t('catalogue_search_programmes_placeholder')}
                        value={programmeQuery} onChange={setProgrammeQuery} />
                    {shownProgrammes.length === 0 && data.programmes.length > 0 ? noMatches : (
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead><tr><th style={th}>{t('staff_programme_label')}</th><th style={th}>{t('staff_status_column')}</th><th style={th}>{t('catalogue_use_column')}</th><th style={th}>{t('staff_actions_column')}</th></tr></thead>
                            <tbody>
                                {shownProgrammes.map((p) => (
                                    <tr key={p.id}>
                                        <td style={td}>
                                            {p.code} – {programmeName(p, i18n)}
                                            {p.aliases?.length > 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('catalogue_aliases', { codes: p.aliases.join(', ') })}</div>}
                                        </td>
                                        <td style={td}>
                                            {statusChip(p.status)}
                                            {/* A visible programme with no active course in the chosen semester */}
                                            {p.status === 'active' && p.no_courses && <> <Chip cue="neutral">{t('catalogue_no_courses_chip')}</Chip></>}
                                        </td>
                                        <td style={td}>{t('catalogue_programme_use', { students: p.students, applications: p.applications })}</td>
                                        <td style={td}>
                                            {toggle('programmes', p)}{remove('programmes', p, p.code)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    )}

                    <h3>{t('catalogue_courses')}</h3>
                    {data.courses.length > 0 && (
                        <ListSearch id="catalogue-course-search" label={t('catalogue_search_courses')} placeholder={t('catalogue_search_courses_placeholder')}
                            value={courseQuery} onChange={setCourseQuery} />
                    )}
                    {data.courses.length === 0 ? <p style={{ color: 'var(--text-muted)' }}>{t('catalogue_no_courses')}</p> : shownCourses.length === 0 ? noMatches : (
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead><tr><th style={th}>{t('staff_programme_label')}</th><th style={th}>{t('catalogue_course_column')}</th><th style={th}>{t('catalogue_credits_column')}</th><th style={th}>{t('staff_status_column')}</th><th style={th}>{t('catalogue_use_column')}</th><th style={th}>{t('staff_actions_column')}</th></tr></thead>
                                <tbody>
                                    {shownCourses.map((c) => (
                                        <tr key={c.id}>
                                            <td style={td}>{c.programme_code}</td>
                                            <td style={td}>{c.course_code} – {c.course_name}</td>
                                            <td style={td}>{c.credits}</td>
                                            <td style={td}>{statusChip(c.status)}</td>
                                            <td style={td}>{t('catalogue_course_use', { applications: c.applications })}</td>
                                            <td style={td}>{!c.semester_closed && toggle('courses', c)}{remove('courses', c, `${c.programme_code} ${c.course_code}`)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            )}
            {confirming && (
                <ConfirmModal title={confirming.title} text={confirming.text} confirmLabel={confirming.confirmLabel} danger={confirming.danger}
                    busy={busy} onConfirm={confirmNow} onCancel={() => setConfirming(null)} />
            )}
        </section>
    );
};

export default Catalogue;
