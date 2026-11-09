import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorCode, getErrorMessage, getFieldErrors } from '../../errorMessage';
import { formatDay } from '../../dates';
import { FINAL_GRADES, gradeText } from '../../grades';
import { DECISION_TEXT_MAX, decisionProblems, replyDeadlineDay, textLength, targetCourse } from '../../reviewerList';

// The decision panel (reviewer Group 6), in two steps:
// 1. the form: approve (final grade 2-5 required, note optional), reject (reason required) or
//    request information (message required, with the date the student must reply by)
// 2. a summary of what will happen, confirmed before anything is saved.
// The backend checks everything again (utils/decisions.js); its translated errors are shown here.

const TITLES = { approved: 'reviewer_confirm_title_approved', needs_info: 'reviewer_confirm_title_needs_info', rejected: 'reviewer_confirm_title_rejected' };
const NOTE_LABELS = { approved: 'reviewer_decision_note_optional', rejected: 'reviewer_decision_rationale', needs_info: 'reviewer_decision_message' };
// After these answers the list is out of date (someone else decided, the student withdrew...)
const STALE_CODES = ['ALREADY_DECIDED', 'WAITING_FOR_STUDENT', 'APPLICATION_WITHDRAWN', 'APPLICATION_NOT_FOUND'];

// The confirm button has the decision's colour (reviewer group L2): approve green, reject red,
// request information amber; Continue / Close stay school blue
const CONFIRM_CUES = { approved: 'approve', rejected: 'reject', needs_info: 'info' };
const button = (primary, cue = null) => ({
    padding: '8px 15px', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold',
    ...(cue ? { backgroundColor: `var(--cue-btn-${cue})`, color: `var(--cue-btn-${cue}-text)`, border: 'none' }
        : primary ? { backgroundColor: 'var(--brand)', color: 'var(--text-on-primary)', border: 'none' }
            : { border: '1px solid var(--border-strong)', backgroundColor: 'var(--surface)', color: 'var(--text)' }),
});
const fieldError = { color: 'var(--error-text)', fontSize: '13px', marginTop: '4px' };

const DecisionModal = ({ app, type, onClose, onDone }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const [step, setStep] = useState('form');
    const [grade, setGrade] = useState(null);
    const [note, setNote] = useState('');
    const [problems, setProblems] = useState({}); // field -> translated message
    const [error, setError] = useState('');
    const [stale, setStale] = useState(false);
    const [saving, setSaving] = useState(false);
    const dialogRef = useRef(null);

    const target = targetCourse(app);
    const course = target.course_name ? `${target.course_code} – ${target.course_name}` : target.course_code;
    const deadline = t('reviewer_decision_deadline', { date: formatDay(replyDeadlineDay(), language) });
    const length = textLength(note.trim());

    // Focus the panel when it opens; Escape closes it (not while saving)
    useEffect(() => { dialogRef.current?.focus(); }, [step]);
    const close = () => { if (!saving) (stale ? onDone : onClose)(); };

    const toConfirm = () => {
        const found = decisionProblems({ type, grade, note });
        setProblems(Object.fromEntries(Object.entries(found).map(([field, code]) => [field, t(`errors.${code}`, { max: DECISION_TEXT_MAX })])));
        if (Object.keys(found).length === 0) setStep('confirm');
    };

    const save = async () => {
        setSaving(true);
        setError('');
        try {
            const json = { status: type, note: note.trim() };
            if (type === 'approved') json.final_grade = grade;
            await http.put(`applications/${app.id}/status`, { json }).json();
            onDone(true);
        } catch (err) {
            const fields = getFieldErrors(err, t);
            if (fields.final_grade || fields.note) {
                // A field problem the panel didn't catch: back to the form, under the field
                setProblems({ grade: fields.final_grade, note: fields.note });
                setStep('form');
            } else {
                setError(getErrorMessage(err, t, 'reviewer_decision_failed'));
                setStale(STALE_CODES.includes(getErrorCode(err)));
            }
        } finally {
            setSaving(false);
        }
    };

    const summary = () => {
        const values = { course, student: app.student_name };
        if (type === 'approved') return t('reviewer_decision_summary_approve', { ...values, grade: gradeText(grade, t, language) });
        if (type === 'rejected') return t('reviewer_decision_summary_reject', values);
        return t('reviewer_decision_summary_needs_info', { ...values, deadline });
    };

    return (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'var(--overlay)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '16px' }}>
            <div
                ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="decision-title"
                onKeyDown={(e) => { if (e.key === 'Escape') close(); }}
                style={{ backgroundColor: 'var(--surface)', color: 'var(--text)', padding: '25px', borderRadius: '10px', width: '480px', maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 5px 15px var(--shadow-modal)', outline: 'none' }}
            >
                <h3 id="decision-title" style={{ marginTop: 0, color: 'var(--link)' }}>{t(TITLES[type])}</h3>
                <p style={{ marginTop: 0, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{course} · {app.student_name}</p>

                {step === 'form' ? (
                    <>
                        {type === 'approved' && (
                            <fieldset style={{ border: '1px solid var(--border)', borderRadius: '6px', padding: '10px 12px', marginBottom: '12px' }}>
                                <legend style={{ fontWeight: 'bold' }}>{t('reviewer_decision_grade')}</legend>
                                {FINAL_GRADES.map((value) => (
                                    <label key={value} style={{ display: 'block', padding: '4px 0', cursor: 'pointer' }}>
                                        <input type="radio" name="final-grade" value={value} checked={grade === value} onChange={() => { setGrade(value); setProblems((p) => ({ ...p, grade: '' })); }} />
                                        {' '}{gradeText(value, t, language)}
                                    </label>
                                ))}
                                {problems.grade && <div role="alert" style={fieldError}>{problems.grade}</div>}
                            </fieldset>
                        )}
                        {type === 'needs_info' && (
                            <p role="note" style={{ padding: '8px 10px', borderRadius: '5px', backgroundColor: 'var(--cue-needs-info-bg)', color: 'var(--cue-needs-info-text)', borderLeft: '4px solid var(--cue-needs-info-border)', fontWeight: 'bold' }}><span aria-hidden="true">⏰ </span>{deadline}</p>
                        )}
                        <label htmlFor="decision-note" style={{ fontWeight: 'bold', fontSize: '14px' }}>{t(NOTE_LABELS[type])}</label>
                        <textarea
                            id="decision-note" value={note} aria-describedby="decision-note-count" aria-invalid={!!problems.note}
                            onChange={(e) => { setNote(e.target.value); setProblems((p) => ({ ...p, note: '' })); }}
                            style={{ width: '100%', height: '120px', marginTop: '8px', padding: '10px', boxSizing: 'border-box', border: '1px solid var(--border-strong)', borderRadius: '4px', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                        />
                        <div id="decision-note-count" style={{ textAlign: 'right', fontSize: '12px', color: length > DECISION_TEXT_MAX ? 'var(--error-text)' : 'var(--text-secondary)' }}>
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
                        {saving && <p role="status" style={{ color: 'var(--text-secondary)' }}>{t('reviewer_decision_submitting')}</p>}
                        {error && <p role="alert" style={{ color: 'var(--error-text)', fontWeight: 'bold' }}>{error}</p>}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                            {stale ? (
                                <button type="button" onClick={close} style={button(true)}>{t('reviewer_decision_close')}</button>
                            ) : (
                                <>
                                    <button type="button" onClick={() => setStep('form')} disabled={saving} style={button(false)}>{t('reviewer_decision_back')}</button>
                                    <button type="button" onClick={save} disabled={saving} style={{ ...button(true, CONFIRM_CUES[type]), cursor: saving ? 'wait' : 'pointer' }}>{t('reviewer_confirm_decision')}</button>
                                </>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default DecisionModal;
