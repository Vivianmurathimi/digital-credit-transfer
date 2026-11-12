import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../../dates';
import { gradeText } from '../../grades';
import { targetCourse, statusCue } from '../../reviewerList';
import Chip, { STATUS_ICONS } from '../reviewer/Chip';
import ApplicationDetails from '../reviewer/ApplicationDetails';

// One application in the committee's list (round 2 Group 2): the reviewer's decision at a glance
// and, once handled, the committee's (Kept / Changed, the final result). Opened: the reviewer's
// detail view, read-only (files, conversation, credit comparison, the decision), with Keep / Change
// while it awaits the committee, unless the member made the reviewer decision themselves.
const CommitteeRow = ({ app, open, onToggle, onAct }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const target = targetCourse(app);
    const detailsId = `committee-app-${app.id}`;
    const reviewerCue = statusCue(app.reviewer_decision);
    const decidedBy = app.decided_by_role === 'admin' ? t('reviewer_decided_by_admin') : (app.decided_by_name || '—');
    const waiting = app.status === 'awaiting_committee';

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
                    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '6px' }}>
                        {waiting
                            ? <Chip cue="awaiting">{t('status_awaiting_committee')}</Chip>
                            : <Chip cue={app.committee_state === 'kept' ? 'approved' : 'needs-info'}>{t(`committee_state_${app.committee_state}`)}</Chip>}
                    </span>
                </div>
                <div style={{ marginTop: '4px' }}>{app.student_name}{app.neptun_code ? ` · ${app.neptun_code}` : ''} · {app.programme_code}</div>
                <div style={{ marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', fontSize: '13px' }}>
                    <span>{t('committee_reviewer_label')}</span>
                    <Chip cue={reviewerCue.cue} icon={STATUS_ICONS[reviewerCue.cue]}>{t(reviewerCue.labelKey)}</Chip>
                    {app.reviewer_decision === 'approved' && <span>{t('reviewer_grade_line', { grade: gradeText(app.reviewer_grade, t, language) })}</span>}
                    <span style={{ color: 'var(--text-secondary)' }}>{t('reviewer_decided_line', { date: app.decided_at ? formatDate(app.decided_at, language) : '—', who: decidedBy })}</span>
                </div>
                {!waiting && (
                    <div style={{ marginTop: '6px', fontSize: '13px' }}>
                        {t('committee_final_line', {
                            status: t(`status_${app.status}`),
                            grade: app.status === 'approved' ? `, ${gradeText(app.final_grade, t, language)}` : '',
                            date: app.committee_at ? formatDate(app.committee_at, language) : '—',
                        })}
                        {app.committee_note && <div style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t('committee_note_line', { note: app.committee_note })}</div>}
                    </div>
                )}
            </button>
            {open && (
                <div id={detailsId}>
                    {waiting && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '0 12px 8px' }}>
                            {app.decided_by_me ? (
                                <p role="note" style={{ margin: 0, color: 'var(--cue-system-text)' }}>{t('committee_own_decision')}</p>
                            ) : (
                                <>
                                    <button type="button" onClick={() => onAct('keep')} style={{ padding: '8px 14px', borderRadius: '5px', border: 'none', fontWeight: 'bold', cursor: 'pointer', backgroundColor: 'var(--cue-btn-approve)', color: 'var(--cue-btn-approve-text)' }}>
                                        {t('committee_keep_button')}
                                    </button>
                                    <button type="button" onClick={() => onAct('change')} style={{ padding: '8px 14px', borderRadius: '5px', border: 'none', fontWeight: 'bold', cursor: 'pointer', backgroundColor: 'var(--cue-btn-info)', color: 'var(--cue-btn-info-text)' }}>
                                        {t('committee_change_button')}
                                    </button>
                                </>
                            )}
                        </div>
                    )}
                    <ApplicationDetails appId={app.id} readOnly readOnlyNote="committee_read_only_details" url={`committee/applications/${app.id}`} pdfUrl={`committee/applications/${app.id}/pdf`} />
                </div>
            )}
        </li>
    );
};

export default CommitteeRow;
