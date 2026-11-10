import React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { formatDateTime } from '../dates';

// Codes the server answers when submitting (or saving a draft) isn't possible right now (Group 3)
export const CLOSED_CODES = ['SUBMISSIONS_CLOSED', 'NO_APPLICATION_PERIOD', 'APPLICATION_PERIOD_NOT_STARTED', 'PROGRAMME_HIDDEN', 'APPLICATIONS_CLOSED'];

const boxStyle = (warning) => ({
    backgroundColor: warning ? 'var(--warning-bg)' : 'var(--danger-bg)',
    color: warning ? 'var(--warning-text)' : 'var(--danger-text)',
    border: `1px solid ${warning ? 'var(--orange)' : 'var(--danger-border)'}`,
    padding: '12px 15px', borderRadius: '5px', marginBottom: '15px', fontWeight: 'bold',
});

/**
 * What the application period means for the form right now (admin round Group 5), shown at its
 * top: not started (with the opening time), closed (by the dates, or by the admin with the reason),
 * the last-days warning "Applications close on <date>", and the student's own late access with its
 * deadline. Nothing while it is simply open. `submission` comes from GET settings/status, which
 * the server's one period rule fills (utils/applicationPeriod.js). Times are shown in Budapest time.
 */
const SubmissionBanner = ({ submission }) => {
    const { t } = useTranslation();
    if (!submission || (submission.state === 'open' && !submission.lateAccess)) return null;
    const language = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2);
    const when = (at) => formatDateTime(at, language);
    const { state, semester, lateAccess } = submission;

    // Late access first: the period may be closed, but this student can still submit
    if (lateAccess) {
        return <div role="status" style={boxStyle(true)}>{t('period_late_access', { date: when(lateAccess.deadline) })}</div>;
    }
    let text;
    if (state === 'last_days') text = t('period_last_days', { date: when(semester.closesAt) });
    else if (state === 'not_started') text = semester?.opensAt ? t('period_not_started', { date: when(semester.opensAt) }) : t('period_not_started_no_date');
    else if (state === 'period_over') text = t('period_over', { date: when(semester.closesAt) });
    else if (state === 'closed_by_admin') text = semester?.closeReason ? t('period_closed_reason', { reason: semester.closeReason }) : t('period_closed');
    // The student's programme was hidden by the admin (admin round Group 4)
    else if (state === 'programme_hidden') text = t('errors.PROGRAMME_HIDDEN');
    else text = t('period_none');

    return <div role="status" style={boxStyle(state === 'last_days')}>{text}</div>;
};

export default SubmissionBanner;
