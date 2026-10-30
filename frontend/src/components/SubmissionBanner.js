import React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { formatDay } from '../dates';

// Codes the server answers when submitting (or saving a draft) isn't possible right now (Group 3)
export const CLOSED_CODES = ['SUBMISSIONS_CLOSED', 'NO_APPLICATION_PERIOD', 'APPLICATION_PERIOD_NOT_STARTED'];

const boxStyle = (warning) => ({
    backgroundColor: warning ? 'var(--warning-bg)' : 'var(--danger-bg)',
    color: warning ? 'var(--warning-text)' : 'var(--danger-text)',
    border: `1px solid ${warning ? 'var(--orange)' : 'var(--danger-border)'}`,
    padding: '12px 15px', borderRadius: '5px', marginBottom: '15px', fontWeight: 'bold',
});

/**
 * What the application period means for the form right now, shown at its top as soon as it opens:
 * not started yet (31), no open period (32), closed by the admin (19), or the warning in the last
 * 7 days. Nothing while it is simply open. `submission` comes from GET settings/status.
 */
const SubmissionBanner = ({ submission }) => {
    const { t } = useTranslation();
    if (!submission || submission.state === 'open') return null;
    const language = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2);
    const day = (value) => formatDay(value, language);
    const { state, semester } = submission;

    let text;
    if (state === 'last_days') text = t('student_period_last_days', { closes: day(semester.closesOn), ends: day(semester.endsOn) });
    else if (state === 'not_started') text = t('student_period_not_started', { date: day(semester.opensOn) });
    else if (state === 'period_over') text = t('student_period_over', { date: day(semester.closesOn) });
    else if (state === 'closed_by_admin') text = t('student_submissions_closed');
    else text = t('student_period_none');

    return <div role="status" style={boxStyle(state === 'last_days')}>{text}</div>;
};

export default SubmissionBanner;
