import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatDay } from '../../dates';

// The semester to look at (reviewer group L3; round 2 Group 1): all semesters in progress (the
// default), one of them (a filter, with its review deadline), or a past one, newest first. Past
// semesters are read-only. Only past semesters with applications of the reviewer's programmes.
// onChange(id, isPast)
const SemesterSelect = ({ semesters, value, onChange }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const inProgress = semesters?.inProgress || [];
    if (!semesters || (semesters.past.length === 0 && inProgress.length < 2)) return null;
    const isPast = (id) => semesters.past.some((s) => s.id === id);
    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
            <label htmlFor="reviewer-semester" style={{ fontWeight: 'bold', color: 'var(--link)' }}>{t('reviewer_semester_label')}</label>
            <select
                id="reviewer-semester" value={value ?? ''}
                onChange={(e) => { const id = e.target.value ? Number(e.target.value) : null; onChange(id, id !== null && isPast(id)); }}
                style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border-strong)', backgroundColor: 'var(--surface)', color: 'var(--text)', font: 'inherit', maxWidth: '100%' }}
            >
                <option value="">{inProgress.length === 1 ? t('reviewer_semester_current_named', { name: inProgress[0].name }) : t('reviewer_semester_current')}</option>
                {inProgress.length > 1 && inProgress.map((s) => (
                    <option key={s.id} value={s.id}>{t('reviewer_semester_in_progress_option', { name: s.name, date: formatDateTime(s.review_ends_at, language) })}</option>
                ))}
                {semesters.past.map((s) => (
                    <option key={s.id} value={s.id}>{t('reviewer_semester_past_option', { name: s.name, date: formatDay(s.ends_on, language) })}</option>
                ))}
            </select>
        </div>
    );
};

export default SemesterSelect;
