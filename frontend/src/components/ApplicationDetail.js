import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../http';
import i18n from '../i18n';
import { openSecureFile } from '../secureFiles';
import { getErrorMessage } from '../errorMessage';
import { statusKey } from '../applicationForm';
import { formatDate, formatDateTime } from '../dates';

const sectionTitle = { fontSize: '15px', margin: '18px 0 6px 0', color: 'var(--link)' };
const fileButton = { background: 'none', border: 'none', padding: 0, color: 'var(--link)', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', textAlign: 'left', overflowWrap: 'anywhere' };
const noteText = { margin: '6px 0 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' };

/**
 * One application in full, read-only, opened from My Status: institutions, fulfilled courses with
 * their files, the target PTE course, syllabus reasons and the history in order.
 * Uses the browser's <dialog> (focus stays inside, Esc closes); focus starts on the heading and
 * the caller puts it back on the button that opened it.
 */
const ApplicationDetail = ({ applicationId, userId, isImpersonating, countryName, statusLabel, statusColor, onClose, onReply }) => {
    const { t } = useTranslation();
    const language = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2);
    const dialogRef = useRef(null);
    const headingRef = useRef(null);
    const [application, setApplication] = useState(null);
    const [error, setError] = useState('');
    const [fileError, setFileError] = useState('');

    // Opened once: as a modal, with focus on the heading
    useEffect(() => {
        const dialog = dialogRef.current;
        if (dialog && !dialog.open) dialog.showModal();
        headingRef.current?.focus();
    }, []);

    useEffect(() => {
        const dialog = dialogRef.current;
        const handleCancel = (event) => { event.preventDefault(); onClose(); };
        dialog?.addEventListener('cancel', handleCancel);
        return () => dialog?.removeEventListener('cancel', handleCancel);
    }, [onClose]);

    useEffect(() => {
        let current = true;
        // The student reads their own application; the impersonating admin reads it by student id
        const path = isImpersonating ? `applications/student/${userId}/${applicationId}` : `applications/mine/${applicationId}`;
        http.get(path).json()
            .then((data) => { if (current) setApplication(data.application); })
            .catch((err) => { if (current) setError(getErrorMessage(err, t, 'student_detail_load_failed')); });
        return () => { current = false; };
    }, [applicationId, userId, isImpersonating, t]);

    const fileName = (stored) => application?.file_names?.[stored] || String(stored || '').replace(/^\d+-/, '');
    const FileLink = ({ file }) => (
        <button type="button" style={fileButton} onClick={() => {
            setFileError('');
            openSecureFile(file).catch((err) => setFileError(getErrorMessage(err, t, 'file_open_failed')));
        }}>{fileName(file)}</button>
    );

    const target = application?.target_courses?.[0];
    const courses = Array.isArray(application?.fulfilled_courses_json) ? application.fulfilled_courses_json : [];
    const institutions = application?.institutions || [];
    const creditSystem = (c) => (c.credit_system === 'OTHER' && c.credit_system_other
        ? c.credit_system_other
        : c.credit_system ? t(`student_credit_system_${c.credit_system}`) : '');

    // A reason code (e.g. an automatic rejection) is shown translated; otherwise the note as written
    const eventNote = (e) => (e.reason_code && i18n.exists(`student_reason_${e.reason_code}`) ? t(`student_reason_${e.reason_code}`) : e.note);
    const eventTitle = (e) => (e.kind === 'decided'
        ? t('student_event_decided', { status: statusLabel(e.status) })
        : t(`student_event_${e.kind}`, { defaultValue: statusLabel(e.status) }));

    return (
        <dialog
            ref={dialogRef}
            aria-labelledby="detail-title"
            style={{ maxWidth: '760px', width: 'calc(100% - 32px)', maxHeight: '88vh', overflowY: 'auto', padding: '20px', borderRadius: '8px', border: '1px solid var(--border-strong)', backgroundColor: 'var(--surface)', color: 'inherit' }}
        >
            <h2 id="detail-title" ref={headingRef} tabIndex={-1} style={{ marginTop: 0, color: 'var(--link)', fontSize: '20px' }}>
                {target ? t('student_target_course_chip', { code: target.course_code, name: target.course_name, credits: target.credits }) : t('student_detail_title')}
            </h2>

            {!application && !error && <p role="status">{t('student_detail_loading')}</p>}
            {error && <p role="alert" style={{ color: 'var(--error-text)', fontWeight: 'bold' }}>{error}</p>}

            {application && (
                <>
                    <p style={{ margin: '0 0 4px 0', display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                        <span style={{ fontWeight: 'bold', padding: '4px 10px', borderRadius: '15px', color: 'white', fontSize: '12px', backgroundColor: statusColor(application.status) }}>{statusLabel(application.status)}</span>
                        <span>{t('student_detail_submitted', { date: formatDateTime(application.submitted_at, language) })}</span>
                    </p>
                    {application.decided_by && statusKey(application.status) !== 'pending' && (
                        <p style={{ margin: '0 0 4px 0', color: 'var(--text-muted)' }}>
                            {t('student_detail_last_change', { who: t(`student_actor_${application.decided_by}`), date: formatDateTime(application.decided_at, language) })}
                        </p>
                    )}
                    {fileError && <p role="alert" style={{ color: 'var(--error-text)', fontWeight: 'bold' }}>{fileError}</p>}

                    <h3 style={sectionTitle}>{t('student_summary_institutions')}</h3>
                    {institutions.map((inst, i) => (
                        <div key={i} style={{ marginBottom: '6px' }}>
                            <strong>{inst.name}</strong>{inst.country ? ` (${countryName(inst.country)})` : ''}
                            {inst.grading_file && <div>{t('student_detail_grading_doc')}: <FileLink file={inst.grading_file} /></div>}
                        </div>
                    ))}

                    <h3 style={sectionTitle}>{t('student_summary_courses')}</h3>
                    {courses.map((c, i) => (
                        <div key={i} style={{ marginBottom: '10px' }}>
                            <strong>{i + 1}. {c.course_name}</strong>{c.course_code ? ` (${c.course_code})` : ''}
                            <ul style={{ margin: '4px 0 0 0', paddingLeft: '18px' }}>
                                {Number.isInteger(c.institution) && institutions[c.institution] && <li>{institutions[c.institution].name}</li>}
                                <li>{t('student_summary_course_line', { credits: c.credits, system: creditSystem(c), grade: c.grade })}</li>
                                {c.file && <li>{t('student_detail_transcript')}: <FileLink file={c.file} /></li>}
                                {c.syllabus_file && <li>{t('student_detail_syllabus')}: <FileLink file={c.syllabus_file} /></li>}
                            </ul>
                        </div>
                    ))}

                    {application.syllabus_reasons?.length > 0 && (
                        <>
                            <h3 style={sectionTitle}>{t('student_syllabus_needed_title')}</h3>
                            <ul style={{ margin: 0, paddingLeft: '18px' }}>
                                {application.syllabus_reasons.map((code) => <li key={code}>{t(`student_syllabus_reason_${code}`)}</li>)}
                            </ul>
                        </>
                    )}

                    <h3 style={sectionTitle}>{t('student_detail_history')}</h3>
                    <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                        {application.events.map((e, i) => (
                            <li key={i} style={{ borderLeft: `4px solid ${e.actor_role === 'student' ? 'var(--border-strong)' : 'var(--link)'}`, padding: '6px 10px', marginBottom: '8px', backgroundColor: 'var(--surface-accent)', borderRadius: '4px' }}>
                                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '6px' }}>
                                    <strong>{eventTitle(e)}</strong>
                                    <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
                                        {t(`student_actor_${e.actor_role}`)} · {e.backfilled ? formatDate(e.created_at, language) : formatDateTime(e.created_at, language)}
                                    </span>
                                </div>
                                {eventNote(e) && <p style={noteText}>{eventNote(e)}</p>}
                                {e.files?.length > 0 && (
                                    <div style={{ marginTop: '6px' }}>
                                        {t('student_event_files')}{' '}
                                        {e.files.map((f, j) => <span key={f}>{j > 0 && ', '}<FileLink file={f} /></span>)}
                                    </div>
                                )}
                                {e.backfilled && <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>{t('student_event_backfilled')}</p>}
                            </li>
                        ))}
                    </ol>
                </>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap', marginTop: '20px' }}>
                {application?.status === 'needs_info' && !isImpersonating && (
                    <button type="button" onClick={() => onReply(application)} style={{ padding: '10px 15px', backgroundColor: 'var(--orange)', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>
                        {t('student_add_missing_info')}
                    </button>
                )}
                <button type="button" onClick={onClose} style={{ padding: '10px 15px', backgroundColor: 'var(--grey)', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>
                    {t('student_detail_close')}
                </button>
            </div>
        </dialog>
    );
};

export default ApplicationDetail;
