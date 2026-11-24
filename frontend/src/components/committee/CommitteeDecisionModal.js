import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorCode, getErrorMessage, getFieldErrors } from '../../errorMessage';
import { FINAL_GRADES, gradeText } from '../../grades';
import { DECISION_TEXT_MAX, textLength, targetCourse } from '../../reviewerList';

// The committee's step (round 2 Group 2), in two steps like the reviewer's decision panel:
// 1. the form (fixes Part A: Change the grade):
//    - approved, keep:          the reviewer's grade stays; no grade to choose
//    - approved, change_grade:  stays approved; another grade is REQUIRED (the reviewer's is greyed out)
//    - approved, change:        becomes rejected; no grade
//    - rejected, keep:          stays rejected; no grade
//    - rejected, change:        becomes approved; the grade is REQUIRED (there is none yet)
//    the note is optional on Keep and Change the grade, required on Change (the decision flips)
// 2. a summary, confirmed before anything is saved.
// The server checks everything again (utils/committee.js). url: where to save (the member's route,
// or the admin's direct step).

const STALE_CODES = ['ALREADY_DECIDED', 'APPLICATION_NOT_FOUND', 'OWN_DECISION', 'SEMESTER_ENDED'];
const button = (primary, cue = null) => ({
    padding: '8px 15px', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold',
    ...(cue ? { backgroundColor: `var(--cue-btn-${cue})`, color: `var(--cue-btn-${cue}-text)`, border: 'none' }
        : primary ? { backgroundColor: 'var(--brand)', color: 'var(--text-on-primary)', border: 'none' }
            : { border: '1px solid var(--border-strong)', backgroundColor: 'var(--surface)', color: 'var(--text)' }),
});
const fieldError = { color: 'var(--error-text)', fontSize: '13px', marginTop: '4px' };

const CommitteeDecisionModal = ({ app, action, url, onClose, onDone }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const reviewerApproved = app.reviewer_decision === 'approved';
    const finalStatus = action === 'keep' ? app.reviewer_decision : action === 'change_grade' ? 'approved' : (reviewerApproved ? 'rejected' : 'approved');
    // A grade is chosen for Change the grade, and for changing a rejection to approved (both required)
    const gradeShown = action === 'change_grade' || (action === 'change' && finalStatus === 'approved');
    const gradeRequired = gradeShown;
    const noteRequired = action === 'change';
    const [step, setStep] = useState('form');
    const [grade, setGrade] = useState(null);
    const [note, setNote] = useState('');
    const [problems, setProblems] = useState({});
    const [error, setError] = useState('');
    const [stale, setStale] = useState(false);
    const [saving, setSaving] = useState(false);
    const dialogRef = useRef(null);

    const target = targetCourse(app);
    const course = target.course_name ? `${target.course_code} – ${target.course_name}` : target.course_code;
    const length = textLength(note.trim());
    useEffect(() => { dialogRef.current?.focus(); }, [step]);
    const close = () => { if (!saving) (stale ? onDone : onClose)(); };

    const toConfirm = () => {
        const found = {};
        if (gradeRequired && !grade) found.grade = t('errors.GRADE_REQUIRED');
        if (action === 'change_grade' && grade === app.reviewer_grade) found.grade = t('errors.GRADE_UNCHANGED');
        if (noteRequired && !note.trim()) found.note = t('errors.COMMITTEE_NOTE_REQUIRED');
        if (length > DECISION_TEXT_MAX) found.note = t('errors.NOTE_TOO_LONG', { max: DECISION_TEXT_MAX });
        setProblems(found);
        if (Object.keys(found).length === 0) setStep('confirm');
    };

    const save = async () => {
        setSaving(true);
        setError('');
        try {
            const json = { action, note: note.trim() };
            if (gradeShown) json.final_grade = grade;
            await http.put(url, { json }).json();
            onDone(true);
        } catch (err) {
            const fields = getFieldErrors(err, t);
            if (fields.final_grade || fields.note) {
                setProblems({ grade: fields.final_grade, note: fields.note });
                setStep('form');
            } else {
                setError(getErrorMessage(err, t, 'committee_decision_failed'));
                setStale(STALE_CODES.includes(getErrorCode(err)));
            }
        } finally {
            setSaving(false);
        }
    };

    const reviewerLine = t('committee_reviewer_decided', {
        decision: t(`status_${app.reviewer_decision}`),
        grade: reviewerApproved ? `, ${gradeText(app.reviewer_grade, t, language)}` : '',
    });
    const summary = () => {
        const values = { course, student: app.student_name, grade: grade ? gradeText(grade, t, language) : '' };
        if (action === 'keep') {
            return t(reviewerApproved ? 'committee_summary_keep_approved' : 'committee_summary_keep_rejected', { ...values, grade: reviewerApproved ? gradeText(app.reviewer_grade, t, language) : '' });
        }
        if (action === 'change_grade') {
            return t('committee_summary_change_grade', { course, student: app.student_name, old: gradeText(app.reviewer_grade, t, language), new: values.grade });
        }
        return t(reviewerApproved ? 'committee_summary_change_to_rejected' : 'committee_summary_change_to_approved', values);
    };

    return (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'var(--overlay)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '16px' }}>
            <div
                ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="committee-decision-title"
                onKeyDown={(e) => { if (e.key === 'Escape') close(); }}
                style={{ backgroundColor: 'var(--surface)', color: 'var(--text)', padding: '25px', borderRadius: '10px', width: '480px', maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 5px 15px var(--shadow-modal)', outline: 'none' }}
            >
                <h3 id="committee-decision-title" style={{ marginTop: 0, color: 'var(--link)' }}>{t(action === 'keep' ? 'committee_keep_title' : action === 'change_grade' ? 'committee_change_grade_title' : 'committee_change_title')}</h3>
                <p style={{ marginTop: 0, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{course} · {app.student_name}</p>
                <p style={{ marginTop: 0, fontWeight: 'bold' }}>{reviewerLine}</p>

                {step === 'form' ? (
                    <>
                        {gradeShown && (
                            <fieldset style={{ border: '1px solid var(--border)', borderRadius: '6px', padding: '10px 12px', marginBottom: '12px' }}>
                                <legend style={{ fontWeight: 'bold' }}>{t('committee_grade_label')}</legend>
                                <p style={{ margin: '0 0 6px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                                    {action === 'change_grade'
                                        ? t('committee_grade_change_hint', { grade: gradeText(app.reviewer_grade, t, language) })
                                        : t('committee_grade_required_hint')}
                                </p>
                                {FINAL_GRADES.map((value) => {
                                    // Change the grade: the reviewer's own grade can't be chosen again
                                    const reviewers = action === 'change_grade' && value === app.reviewer_grade;
                                    return (
                                        <label key={value} style={{ display: 'block', padding: '4px 0', cursor: reviewers ? 'not-allowed' : 'pointer', color: reviewers ? 'var(--text-secondary)' : undefined }}>
                                            <input type="radio" name="committee-grade" value={value} checked={grade === value} disabled={reviewers}
                                                onChange={() => { setGrade(value); setProblems((p) => ({ ...p, grade: '' })); }} />
                                            {' '}{gradeText(value, t, language)}{reviewers ? ` (${t('committee_grade_reviewers')})` : ''}
                                        </label>
                                    );
                                })}
                                {problems.grade && <div role="alert" style={fieldError}>{problems.grade}</div>}
                            </fieldset>
                        )}
                        <label htmlFor="committee-note" style={{ fontWeight: 'bold', fontSize: '14px' }}>{t(noteRequired ? 'committee_note_required' : 'committee_note_optional')}</label>
                        <textarea
                            id="committee-note" value={note} aria-describedby="committee-note-count" aria-invalid={!!problems.note}
                            onChange={(e) => { setNote(e.target.value); setProblems((p) => ({ ...p, note: '' })); }}
                            style={{ width: '100%', height: '120px', marginTop: '8px', padding: '10px', boxSizing: 'border-box', border: '1px solid var(--border-strong)', borderRadius: '4px', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                        />
                        <div id="committee-note-count" style={{ textAlign: 'right', fontSize: '12px', color: length > DECISION_TEXT_MAX ? 'var(--error-text)' : 'var(--text-secondary)' }}>
                            {t('reviewer_decision_counter', { count: length, max: DECISION_TEXT_MAX })}
                        </div>
                        {problems.note && <div role="alert" style={fieldError}>{problems.note}</div>}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                            <button type="button" onClick={close} style={button(false)}>{t('reviewer_cancel')}</button>
                            <button type="button" onClick={toConfirm} style={button(true)}>{t('reviewer_decision_continue')}</button>
                        </div>
                    </>
                ) : (
                    <>
                        <p style={{ fontWeight: 'bold', fontSize: '16px', overflowWrap: 'anywhere' }}>{summary()}</p>
                        {note.trim() && (
                            <div style={{ maxHeight: '160px', overflowY: 'auto', padding: '8px 10px', borderRadius: '5px', backgroundColor: 'var(--surface-2)', border: '1px solid var(--border)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '14px' }}>
                                {note.trim()}
                            </div>
                        )}
                        <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{t('committee_final_warning')}</p>
                        {saving && <p role="status" style={{ color: 'var(--text-secondary)' }}>{t('reviewer_decision_submitting')}</p>}
                        {error && <p role="alert" style={{ color: 'var(--error-text)', fontWeight: 'bold' }}>{error}</p>}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                            {stale ? (
                                <button type="button" onClick={close} style={button(true)}>{t('reviewer_decision_close')}</button>
                            ) : (
                                <>
                                    <button type="button" disabled={saving} onClick={() => setStep('form')} style={button(false)}>{t('reviewer_decision_back')}</button>
                                    <button type="button" disabled={saving} onClick={save} style={button(true, finalStatus === 'approved' ? 'approve' : 'reject')}>{t('committee_confirm_button')}</button>
                                </>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default CommitteeDecisionModal;
