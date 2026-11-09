import React from 'react';
import { useTranslation } from 'react-i18next';
import { creditComparison } from '../../reviewerList';
import Chip from './Chip';

// Fulfilled credits against the target course (reviewer Group 4). All ECTS: the total against
// what is required, with Enough / Not enough. Any other credit system: every course's credits
// with its system, to be compared by hand.
// Colour cues (reviewer group L2): green "Credits: enough", red "Credits: not enough", grey "compare manually".

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
                    <span style={{ marginLeft: '8px' }}>
                        {result.enough
                            ? <Chip cue="approved" icon="✓">{t('reviewer_credits_enough')}</Chip>
                            : <Chip cue="rejected" icon="✗">{t('reviewer_credits_not_enough')}</Chip>}
                    </span>
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
            <div role="note" style={{ marginTop: '6px' }}>
                <Chip cue="neutral" icon="⚖">{t('reviewer_credits_manual')}</Chip>
            </div>
        </div>
    );
};

export default CreditComparison;
