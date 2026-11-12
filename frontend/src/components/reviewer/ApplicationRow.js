import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../../dates';
import { respondByLevel, statusCue, targetCourse, waitingLevel } from '../../reviewerList';
import { gradeText } from '../../grades';
import ApplicationDetails from './ApplicationDetails';
import Chip, { STATUS_ICONS } from './Chip';

// One application: a summary line that opens into the details.
// Colour cues (reviewer group L2): the status chip, "Resubmitted", the waiting time of a pending
// application (amber from 7 days, red from 14) and the reply deadline (red when 1 day or less is left).
// Hover and the open row's highlight come from the reviewer-row class (theme/theme.css).
const WAITING_CUES = { warn: { cue: 'needs-info', icon: '⏱' }, late: { cue: 'rejected', icon: '⚠' } };

// readOnly: a past semester (reviewer group L3): no waiting or deadline cues, no decision buttons
// showProgramme: the reviewer sees more than one programme (round 2 Group 1): the row names its programme's code
// me: the reviewer's id, so "Assigned to you" differs from "Assigned to X" (round 2 Group 1)
const ApplicationRow = ({ app, open, readOnly = false, showProgramme = false, me = null, onToggle, onShowStudent, onDecide }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const target = targetCourse(app);
    const detailsId = `reviewer-app-${app.id}`;

    // Who decided: the reviewer's name, or "Admin" / "System"; "—" for old decisions without it
    const decidedBy = app.decided_by_role === 'system' ? t('reviewer_decided_by_system')
        : app.decided_by_role === 'admin' ? t('reviewer_decided_by_admin')
            : app.decided_by_role === 'reviewer' ? (app.decided_by_name || '—') : '—';

    const status = statusCue(app.status, app.decided_by_role);
    const waitingText = t('reviewer_waiting_days', { count: app.waiting_days });
    const waiting = app.status === 'pending' && !readOnly ? WAITING_CUES[waitingLevel(app.waiting_days)] : null;
    const respondLate = app.status === 'needs_info' && app.respond_by && respondByLevel(app.respond_by) === 'late';

    return (
        <li className={`reviewer-row${open ? ' is-open' : ''}`} style={{ listStyle: 'none', marginBottom: '10px', border: '1px solid var(--border-strong)', borderRadius: '8px', backgroundColor: 'var(--surface)' }}>
            <button
                type="button" onClick={onToggle} aria-expanded={open} aria-controls={detailsId}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '12px', border: 'none', background: 'none', color: 'var(--text)', cursor: 'pointer', font: 'inherit' }}
            >
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '8px' }}>
                    <strong style={{ color: 'var(--link)' }}>
                        <span aria-hidden="true">{open ? '▾' : '▸'} </span>
                        {target.course_code}{target.course_name ? ` – ${target.course_name}` : ''}
                    </strong>
                    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '6px' }}>
                        {app.resubmit_count > 0 && app.status === 'pending' && <Chip cue="resubmitted" icon="🔄">{t('reviewer_resubmitted')}</Chip>}
                        <Chip cue={status.cue} icon={STATUS_ICONS[status.cue]} size={app.status === 'approved' || app.status === 'rejected' ? 'large' : 'normal'}>{t(status.labelKey)}</Chip>
                    </span>
                </div>
                <div style={{ marginTop: '4px' }}>
                    {app.student_name}{app.neptun_code ? ` · ${app.neptun_code}` : ''}{showProgramme && app.programme_code ? ` · ${app.programme_code}` : ''}
                </div>
                <div style={{ marginTop: '4px', fontSize: '13px', color: 'var(--text-secondary)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }}>
                    <span>{t('reviewer_submitted_on', { date: formatDate(app.submitted_at, language) })}</span>
                    {!readOnly && <span aria-hidden="true">·</span>}
                    {readOnly ? null : waiting ? <Chip cue={waiting.cue} icon={waiting.icon}>{waitingText}</Chip> : <span>{waitingText}</span>}
                </div>
                {app.status === 'needs_info' && app.respond_by && !readOnly && (
                    <div style={{ marginTop: '6px' }}>
                        <Chip cue={respondLate ? 'rejected' : 'needs-info'} icon={respondLate ? '⚠' : '⏰'}>
                            {t('reviewer_respond_by', { date: formatDate(app.respond_by, language) })}
                        </Chip>
                    </div>
                )}
                {!readOnly && (app.status === 'pending' || app.status === 'needs_info') && (
                    <div style={{ marginTop: '4px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                        {app.assigned_reviewer_id == null ? t('reviewer_assigned_nobody')
                            : app.assigned_reviewer_id === me ? t('reviewer_assigned_you') : t('reviewer_assigned_to', { name: app.assigned_name || '—' })}
                    </div>
                )}
                {(app.status === 'approved' || app.status === 'rejected') && (
                    <div style={{ marginTop: '4px', fontSize: '13px' }}>
                        {app.status === 'approved' && <>{t('reviewer_grade_line', { grade: gradeText(app.final_grade, t, language) })}{' · '}</>}
                        {t('reviewer_decided_line', { date: app.decided_at ? formatDate(app.decided_at, language) : '—', who: decidedBy })}
                    </div>
                )}
            </button>

            {open && (
                <div id={detailsId}>
                    {/* Counted by the backend among what this reviewer may see; a link only when there are some */}
                    <div style={{ padding: '0 12px 8px' }}>
                        {app.other_count > 0 ? (
                            <button type="button" onClick={onShowStudent} style={{ cursor: 'pointer', border: 'none', background: 'none', padding: 0, color: 'var(--link)', textDecoration: 'underline', font: 'inherit' }}>
                                {t('reviewer_other_applications', { count: app.other_count })}
                            </button>
                        ) : (
                            <span style={{ color: 'var(--text-secondary)' }}>{t('reviewer_other_applications', { count: 0 })}</span>
                        )}
                    </div>
                    <ApplicationDetails appId={app.id} onDecide={onDecide} readOnly={readOnly} />
                </div>
            )}
        </li>
    );
};

export default ApplicationRow;
