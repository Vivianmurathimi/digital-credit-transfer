import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime, toBudapestInput } from '../../dates';
import { input, label } from './adminStyles';

// Reopen until and late access (round 2 Group 1) may run up to the semester's review deadline.
// When the new end is after it, or leaves fewer than `margin` days for reviewing, this offers to
// move the review deadline in the same step (the server checks it again). Both times are Budapest
// wall-clock strings ("2026-12-01T23:59"), compared as such.

const DAY = 24 * 60 * 60 * 1000;
const wallClock = (value) => new Date(`${value}:00Z`).getTime(); // a Budapest wall-clock time as a number
const plusDays = (value, days) => new Date(wallClock(value) + days * DAY).toISOString().slice(0, 16);

/**
 * What a new end means for the review deadline: null (fine), 'tight' or 'after'.
 * @param {string} newEnd       "YYYY-MM-DDTHH:mm" (Budapest)
 * @param {string} reviewEndAt  the semester's review deadline (ISO)
 */
export const reviewSituation = (newEnd, reviewEndAt, margin) => {
    if (!newEnd || !reviewEndAt) return null;
    const left = wallClock(toBudapestInput(reviewEndAt)) - wallClock(newEnd);
    if (left < 0) return 'after';
    return left < margin * DAY ? 'tight' : null;
};

// The suggested new review deadline: the new end plus `margin` days
export const suggestedReviewEnd = (newEnd, margin) => (newEnd ? plusDays(newEnd, margin) : '');

const ReviewDeadlineMove = ({ id, newEnd, reviewEndAt, margin, value, onChange }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const situation = reviewSituation(newEnd, reviewEndAt, margin);
    if (!situation) return null;
    return (
        <div role="note" style={{ gridColumn: '1 / -1', padding: '8px 10px', borderRadius: '6px', backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)' }}>
            <p style={{ margin: '0 0 6px' }}>
                {t(situation === 'after' ? 'review_move_after' : 'review_move_tight', { date: formatDateTime(reviewEndAt, language), days: margin })}
            </p>
            <label htmlFor={id} style={label}>{t('review_move_label')}</label>
            <input id={id} type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} style={{ ...input, maxWidth: '260px' }} />
        </div>
    );
};

export default ReviewDeadlineMove;
