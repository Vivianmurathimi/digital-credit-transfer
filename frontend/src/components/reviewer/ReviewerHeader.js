import React from 'react';
import { useTranslation } from 'react-i18next';
import { programmeName } from '../../programmeName';
import { formatDateTime } from '../../dates';

// "Reviewer – Computer Science Engineering" and the reviewer's name (the backend sends it; while
// the admin acts as the reviewer, the session is the reviewer's). Several programmes are listed
// together (round 2 Group 1); a programme on standby (extra reviewer not allowed to assist yet)
// is named below, since its applications are not shown.
// semesters: the semesters in progress (round 2 Group 1), each named with its review deadline
const ReviewerHeader = ({ reviewer, semester, semesters = null }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    if (!reviewer) return null;
    const programmes = reviewer.programmes || [];
    const seen = programmes.filter((p) => p.sees);
    const standby = programmes.filter((p) => !p.sees);
    return (
        <div style={{ marginBottom: '15px' }}>
            <h2 style={{ margin: 0, color: 'var(--success-text)' }}>
                {seen.length > 0
                    ? t('reviewer_header_title', { programme: seen.map((p) => programmeName(p, i18n)).join(', ') })
                    : t('reviewer_header_no_programme')}
            </h2>
            {standby.length > 0 && (
                <p role="status" style={{ margin: '6px 0 0', color: 'var(--text-secondary)' }}>
                    {t('reviewer_header_standby', { programmes: standby.map((p) => programmeName(p, i18n)).join(', ') })}
                </p>
            )}
            <div style={{ color: 'var(--text-secondary)', marginTop: '4px' }}>
                <strong>{reviewer.name}</strong>
                {' · '}
                {semesters && semesters.length > 0
                    ? t('reviewer_header_semesters', { list: semesters.map((s) => t('reviewer_header_semester_review', { name: s.name, date: formatDateTime(s.review_ends_at, language) })).join('; ') })
                    : semester ? t('reviewer_header_semester', { name: semester.name }) : t('reviewer_no_semester')}
            </div>
        </div>
    );
};

export default ReviewerHeader;
