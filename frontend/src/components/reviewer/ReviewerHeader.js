import React from 'react';
import { useTranslation } from 'react-i18next';
import { programmeName } from '../../programmeName';

// "Reviewer – Computer Science Engineering" and the reviewer's name. While the superadmin
// impersonates a reviewer, this is that reviewer's header (the backend sends whose view it is).
const ReviewerHeader = ({ reviewer, semester }) => {
    const { t, i18n } = useTranslation();
    if (!reviewer) return null;
    return (
        <div style={{ marginBottom: '15px' }}>
            <h2 style={{ margin: 0, color: 'var(--success-text)' }}>
                {t('reviewer_header_title', { programme: reviewer.programme ? programmeName(reviewer.programme, i18n) : '' })}
            </h2>
            <div style={{ color: 'var(--text-secondary)', marginTop: '4px' }}>
                <strong>{reviewer.name}</strong>
                {' · '}
                {semester ? t('reviewer_header_semester', { name: semester.name }) : t('reviewer_no_semester')}
            </div>
        </div>
    );
};

export default ReviewerHeader;
