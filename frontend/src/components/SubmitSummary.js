import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

// A short list of label/value lines
const Lines = ({ items }) => (
    <ul style={{ margin: '4px 0 0 0', paddingLeft: '18px' }}>
        {items.filter(Boolean).map((text) => <li key={text} style={{ marginBottom: '2px' }}>{text}</li>)}
    </ul>
);

const sectionTitle = { fontSize: '14px', margin: '14px 0 4px 0', color: 'var(--link)' };

/**
 * Confirmation before the final submit: everything that will be sent to the reviewer.
 * Uses the browser's <dialog>, which keeps keyboard focus inside and closes with Esc.
 * Focus starts on the heading; the caller puts it back on the Submit button when it closes.
 */
const SubmitSummary = ({
    institutions, rows, targetCourse, syllabusReasons, note,
    countryName, institutionLabel, fileName, busy, onBack, onConfirm,
}) => {
    const { t } = useTranslation();
    const dialogRef = useRef(null);
    const headingRef = useRef(null);

    // Opened once: as a modal, with focus on the heading
    useEffect(() => {
        const dialog = dialogRef.current;
        if (dialog && !dialog.open) dialog.showModal();
        headingRef.current?.focus();
    }, []);

    useEffect(() => {
        const dialog = dialogRef.current;
        // Esc (or the browser closing it) counts as "Back to edit"
        const handleCancel = (event) => { event.preventDefault(); if (!busy) onBack(); };
        dialog?.addEventListener('cancel', handleCancel);
        return () => dialog?.removeEventListener('cancel', handleCancel);
    }, [busy, onBack]);

    const creditSystem = (row) => (row.credit_system === 'OTHER' && row.credit_system_other.trim()
        ? row.credit_system_other.trim()
        : t(`student_credit_system_${row.credit_system}`));
    const institutionOf = (row) => {
        const index = institutions.findIndex((i) => i.key === row.institutionKey);
        return index >= 0 ? institutionLabel(institutions[index], index) : '';
    };

    return (
        <dialog
            ref={dialogRef}
            aria-labelledby="summary-title"
            style={{ maxWidth: '720px', width: 'calc(100% - 32px)', maxHeight: '85vh', overflowY: 'auto', padding: '20px', borderRadius: '8px', border: '1px solid var(--border-strong)', backgroundColor: 'var(--surface)', color: 'inherit' }}
        >
            <h2 id="summary-title" ref={headingRef} tabIndex={-1} style={{ marginTop: 0, color: 'var(--link)', fontSize: '20px' }}>{t('student_summary_title')}</h2>
            <p style={{ marginTop: 0, color: 'var(--text-muted)' }}>{t('student_summary_intro')}</p>

            <h3 style={sectionTitle}>{t('student_summary_target')}</h3>
            <p style={{ margin: 0, fontWeight: 'bold' }}>{t('student_target_course_chip', { code: targetCourse.course_code, name: targetCourse.course_name, credits: targetCourse.credits })}</p>

            <h3 style={sectionTitle}>{t('student_summary_institutions')}</h3>
            {institutions.map((inst, i) => (
                <div key={inst.key} style={{ marginBottom: '6px' }}>
                    <strong>{inst.name.trim()}</strong> ({countryName(inst.country)})
                    <Lines items={[t('student_summary_grading', { file: fileName(inst.grading_file) })]} />
                </div>
            ))}

            <h3 style={sectionTitle}>{t('student_summary_courses')}</h3>
            {rows.map((row, index) => (
                <div key={row.id} style={{ marginBottom: '8px' }}>
                    <strong>{index + 1}. {row.course_name.trim()}</strong>{row.course_code.trim() ? ` (${row.course_code.trim()})` : ''}
                    <Lines items={[
                        institutionOf(row),
                        t('student_summary_course_line', { credits: row.credits, system: creditSystem(row), grade: row.grade.trim() }),
                        t('student_summary_transcript', { file: fileName(row.file) }),
                        row.syllabus_file ? t('student_summary_syllabus', { file: fileName(row.syllabus_file) }) : null,
                    ]} />
                </div>
            ))}

            {syllabusReasons.length > 0 && (
                <>
                    <h3 style={sectionTitle}>{t('student_syllabus_needed_title')}</h3>
                    <Lines items={syllabusReasons.map((code) => t(`student_syllabus_reason_${code}`))} />
                </>
            )}

            <h3 style={sectionTitle}>{t('student_summary_note')}</h3>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{note.trim() ? note : <em>{t('student_summary_no_note')}</em>}</p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap', marginTop: '20px' }}>
                <button type="button" onClick={onBack} disabled={busy} style={{ padding: '10px 15px', backgroundColor: 'var(--grey)', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>
                    {t('student_summary_back')}
                </button>
                <button type="button" onClick={onConfirm} disabled={busy} style={{ padding: '10px 15px', backgroundColor: 'var(--brand)', color: 'white', border: 'none', borderRadius: '5px', cursor: busy ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}>
                    {busy ? t('student_submit_saving') : t('student_summary_confirm')}
                </button>
            </div>
        </dialog>
    );
};

export default SubmitSummary;
