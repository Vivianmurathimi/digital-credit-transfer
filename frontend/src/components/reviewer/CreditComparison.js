import React from 'react';
import { useTranslation } from 'react-i18next';
import { creditComparison } from '../../reviewerList';

// Fulfilled credits against the target course (reviewer Group 4). All ECTS: the total against
// what is required, with Enough / Not enough. Any other credit system: every course's credits
// with its system, to be compared by hand.
const badge = (ok) => ({
    display: 'inline-block', marginLeft: '8px', padding: '2px 10px', borderRadius: '10px', fontWeight: 'bold', fontSize: '13px',
    backgroundColor: ok ? 'var(--success-bg)' : 'var(--danger-bg)', color: ok ? 'var(--success-text)' : 'var(--danger-text)',
    border: `1px solid ${ok ? 'var(--success-border)' : 'var(--danger-border)'}`,
});

const CreditComparison = ({ courses, requiredCredits, formatCredits, creditSystemName }) => {
    const { t } = useTranslation();
    const result = creditComparison(courses, requiredCredits);

    if (result.mode === 'ects') {
        return (
            <div>
                <span>
                    {result.required === null
                        ? t('reviewer_credits_fulfilled_only', { fulfilled: formatCredits(result.total) })
                        : t('reviewer_credits_fulfilled', { fulfilled: formatCredits(result.total), required: formatCredits(result.required) })}
                </span>
                {result.enough !== null && (
                    <span style={badge(result.enough)}>{result.enough ? `✓ ${t('reviewer_credits_enough')}` : `✗ ${t('reviewer_credits_not_enough')}`}</span>
                )}
            </div>
        );
    }

    return (
        <div>
            <ul style={{ margin: '0 0 8px', paddingLeft: '20px' }}>
                {courses.map((course, idx) => (
                    <li key={idx}>{course.course_name}: {formatCredits(course.credits)} {creditSystemName(course)}</li>
                ))}
            </ul>
            {requiredCredits !== null && requiredCredits !== undefined && (
                <div>{t('reviewer_credits_required', { required: formatCredits(requiredCredits) })}</div>
            )}
            <div role="note" style={{ marginTop: '6px', padding: '8px 10px', borderRadius: '5px', backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)', fontWeight: 'bold' }}>
                ⚠ {t('reviewer_credits_manual')}
            </div>
        </div>
    );
};

export default CreditComparison;
