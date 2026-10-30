import React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { formatDateTime } from '../dates';

const DAY_MS = 24 * 60 * 60 * 1000;

// 'open', 'soon' (less than a day left) or 'passed'
export const deadlineState = (deadline, now = Date.now()) => {
    const left = new Date(deadline).getTime() - now;
    if (left <= 0) return 'passed';
    return left < DAY_MS ? 'soon' : 'open';
};

/**
 * "Respond by 2 November 2026, 23:59" for an application waiting for the student's reply,
 * with a clear warning when less than a day is left or the deadline has passed.
 */
const ReplyDeadline = ({ deadline, style }) => {
    const { t } = useTranslation();
    if (!deadline) return null;
    const language = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2);
    const state = deadlineState(deadline);
    return (
        <div style={{ margin: '0 0 8px 0', ...style }}>
            <strong>{t('student_respond_by', { date: formatDateTime(deadline, language) })}</strong>
            {state !== 'open' && (
                <p style={{ margin: '6px 0 0 0', padding: '6px 10px', borderRadius: '4px', fontWeight: 'bold', backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', borderLeft: '4px solid var(--red)' }}>
                    ⚠ {t(state === 'soon' ? 'student_deadline_soon' : 'student_deadline_passed')}
                </p>
            )}
        </div>
    );
};

export default ReplyDeadline;
