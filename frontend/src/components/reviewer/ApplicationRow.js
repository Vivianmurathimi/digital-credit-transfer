import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../../dates';
import { targetCourse } from '../../reviewerList';
import { gradeText } from '../../grades';
import ApplicationDetails from './ApplicationDetails';

// One application: a summary line that opens into the details
const DECISION_COLORS = { approved: 'var(--ok-text)', rejected: 'var(--error-text)' };

// searchParams: { as_reviewer } while the superadmin impersonates (the details are that reviewer's view too)
const ApplicationRow = ({ app, open, onToggle, onShowStudent, onDecide, searchParams }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const target = targetCourse(app);
    const detailsId = `reviewer-app-${app.id}`;

    // Who decided: the reviewer's name, or "Admin" / "System"; "—" for old decisions without it
    const decidedBy = app.decided_by_role === 'system' ? t('reviewer_decided_by_system')
        : app.decided_by_role === 'admin' ? t('reviewer_decided_by_admin')
            : app.decided_by_role === 'reviewer' ? (app.decided_by_name || '—') : '—';

    return (
        <li style={{ listStyle: 'none', marginBottom: '10px', border: '1px solid var(--border-strong)', borderRadius: '8px', backgroundColor: 'var(--surface)' }}>
            <button
                type="button" onClick={onToggle} aria-expanded={open} aria-controls={detailsId}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '12px', border: 'none', background: 'none', color: 'var(--text)', cursor: 'pointer', font: 'inherit' }}
            >
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '8px' }}>
                    <strong style={{ color: 'var(--link)' }}>
                        <span aria-hidden="true">{open ? '▾' : '▸'} </span>
                        {target.course_code}{target.course_name ? ` – ${target.course_name}` : ''}
                    </strong>
                    {app.resubmit_count > 0 && (
                        <span style={{ fontSize: '12px', fontWeight: 'bold', padding: '2px 8px', borderRadius: '10px', backgroundColor: 'var(--info-bg)', color: 'var(--info-text)', border: '1px solid var(--info-border)' }}>
                            {t('reviewer_resubmitted')}
                        </span>
                    )}
                </div>
                <div style={{ marginTop: '4px' }}>
                    {app.student_name}{app.neptun_code ? ` · ${app.neptun_code}` : ''}
                </div>
                <div style={{ marginTop: '4px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                    {t('reviewer_submitted_on', { date: formatDate(app.submitted_at, language) })}
                    {' · '}
                    {t('reviewer_waiting_days', { count: app.waiting_days })}
                </div>
                {app.status === 'needs_info' && app.respond_by && (
                    <div style={{ marginTop: '4px', fontSize: '13px', color: 'var(--orange-text)', fontWeight: 'bold' }}>
                        {t('reviewer_respond_by', { date: formatDate(app.respond_by, language) })}
                    </div>
                )}
                {(app.status === 'approved' || app.status === 'rejected') && (
                    <div style={{ marginTop: '4px', fontSize: '13px' }}>
                        <strong style={{ color: DECISION_COLORS[app.status] }}>{t(`status_${app.status}`)}</strong>
                        {app.status === 'approved' && <>{' · '}{t('reviewer_grade_line', { grade: gradeText(app.final_grade, t, language) })}</>}
                        {' · '}
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
                    <ApplicationDetails appId={app.id} searchParams={searchParams} onDecide={onDecide} />
                </div>
            )}
        </li>
    );
};

export default ApplicationRow;
