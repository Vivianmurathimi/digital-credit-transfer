import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage } from '../../errorMessage';
import { programmeName } from '../../programmeName';
import Chip from '../reviewer/Chip';
import { card, disabledButton, input, label, smallButton, td, th } from './adminStyles';

// Programmes & Courses (admin round Group 4): every programme and the chosen semester's courses,
// with status and how many students and applications use each. Hide and Show at any time (Hide
// keeps all data); Delete only when nothing uses the item, otherwise greyed out with the reason.

const Catalogue = ({ semesters, reloadKey }) => {
    const { t, i18n } = useTranslation();
    const [semesterId, setSemesterId] = useState('');
    const [data, setData] = useState(null);
    const [error, setError] = useState('');

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

    const act = async (confirmText, request) => {
        if (confirmText && !window.confirm(confirmText)) return;
        setError('');
        try { await request(); } catch (err) { setError(getErrorMessage(err, t, 'catalogue_action_failed')); }
        load();
    };
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

            {data && (
                <>
                    <h3>{t('catalogue_programmes')}</h3>
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead><tr><th style={th}>{t('staff_programme_label')}</th><th style={th}>{t('staff_status_column')}</th><th style={th}>{t('catalogue_use_column')}</th><th style={th}>{t('staff_actions_column')}</th></tr></thead>
                            <tbody>
                                {data.programmes.map((p) => (
                                    <tr key={p.id}>
                                        <td style={td}>{p.code} – {programmeName(p, i18n)}</td>
                                        <td style={td}>{statusChip(p.status)}</td>
                                        <td style={td}>{t('catalogue_programme_use', { students: p.students, applications: p.applications })}</td>
                                        <td style={td}>{toggle('programmes', p)}{remove('programmes', p, p.code)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <h3>{t('catalogue_courses')}</h3>
                    {data.courses.length === 0 ? <p style={{ color: 'var(--text-muted)' }}>{t('catalogue_no_courses')}</p> : (
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead><tr><th style={th}>{t('staff_programme_label')}</th><th style={th}>{t('catalogue_course_column')}</th><th style={th}>{t('catalogue_credits_column')}</th><th style={th}>{t('staff_status_column')}</th><th style={th}>{t('catalogue_use_column')}</th><th style={th}>{t('staff_actions_column')}</th></tr></thead>
                                <tbody>
                                    {data.courses.map((c) => (
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
        </section>
    );
};

export default Catalogue;
