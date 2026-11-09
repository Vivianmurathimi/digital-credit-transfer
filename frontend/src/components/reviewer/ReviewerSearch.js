import React from 'react';
import { useTranslation } from 'react-i18next';

// The search box (searched in the browser: the list is already limited to the reviewer's programme)
// and, when set, the "only this student's applications" filter with a button to clear it
const ReviewerSearch = ({ query, onQueryChange, student, onClearStudent }) => {
    const { t } = useTranslation();
    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', marginBottom: '15px' }}>
            <label htmlFor="reviewer-search" style={{ fontWeight: 'bold' }}>{t('reviewer_search_label')}</label>
            <input
                id="reviewer-search" type="search" value={query} onChange={(e) => onQueryChange(e.target.value)}
                placeholder={t('reviewer_search_placeholder')}
                style={{ flex: '1 1 260px', padding: '8px 10px', border: '1px solid var(--border-strong)', borderRadius: '4px', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
            />
            {student && (
                <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderRadius: '16px', backgroundColor: 'var(--info-bg)', color: 'var(--info-text)', border: '1px solid var(--info-border)' }}>
                    {t('reviewer_filter_student', { name: student.name })}
                    <button type="button" onClick={onClearStudent} style={{ cursor: 'pointer', border: 'none', background: 'none', color: 'var(--info-text)', fontWeight: 'bold', textDecoration: 'underline' }}>
                        {t('reviewer_filter_clear')}
                    </button>
                </span>
            )}
        </div>
    );
};

export default ReviewerSearch;
