import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatDay } from '../../dates';

// The semester to look at (reviewer group L3): the current one (default) or a past one, newest
// first. Past semesters are read-only. Only semesters with applications of the reviewer's programme.
const SemesterSelect = ({ semesters, value, onChange }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    if (!semesters || semesters.past.length === 0) return null;
    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
            <label htmlFor="reviewer-semester" style={{ fontWeight: 'bold', color: 'var(--link)' }}>{t('reviewer_semester_label')}</label>
            <select
                id="reviewer-semester" value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
                style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border-strong)', backgroundColor: 'var(--surface)', color: 'var(--text)', font: 'inherit', maxWidth: '100%' }}
            >
                <option value="">{semesters.current ? t('reviewer_semester_current_named', { name: semesters.current.name }) : t('reviewer_semester_current')}</option>
                {semesters.past.map((s) => (
                    <option key={s.id} value={s.id}>{t('reviewer_semester_past_option', { name: s.name, date: formatDay(s.ends_on, language) })}</option>
                ))}
            </select>
        </div>
    );
};

export default SemesterSelect;
