import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage } from '../../errorMessage';
import { programmeName } from '../../programmeName';
import FileLink from './FileLink';
import CreditComparison from './CreditComparison';
import { formatDate } from '../../dates';
import { gradeText } from '../../grades';
import NotesConversation from './NotesConversation';
import HistoryTable from './HistoryTable';

// An opened row (reviewer Group 4): the student, the target course, every fulfilled course with
// its institution and files, each institution's grading system, and the credit comparison.
// Loaded when the row is opened, from the reviewer's own programme only.
// Below them, the notes as one conversation and the history (reviewer Group 5), and the decision
// (reviewer Group 6): the outcome once decided, the decision buttons while it is pending.

const sectionTitle = { margin: '0 0 8px', fontSize: '15px', color: 'var(--text-strong)' };
const box = { padding: '10px 12px', border: '1px solid var(--border)', borderRadius: '6px', backgroundColor: 'var(--surface-2)' };
const muted = { color: 'var(--text-secondary)', fontSize: '14px' };

const ApplicationDetails = ({ appId, searchParams, onDecide }) => {
    const { t, i18n } = useTranslation();
    const language = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2);
    const [details, setDetails] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        let current = true;
        setDetails(null);
        setError('');
        http.get(`reviewer/applications/${appId}`, { searchParams }).json()
            .then((data) => { if (current) setDetails(data.application); })
            .catch((err) => { if (current) setError(getErrorMessage(err, t, 'reviewer_details_failed')); });
        return () => { current = false; };
    }, [appId, searchParams, t]);

    if (error) return <div role="alert" style={{ margin: '0 12px 12px', backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', padding: '10px', borderRadius: '5px', borderLeft: '4px solid var(--red)' }}>{error}</div>;
    if (!details) return <p role="status" style={{ ...muted, padding: '0 12px 12px', margin: 0 }}>{t('reviewer_details_loading')}</p>;

    let countryNames = null;
    try { countryNames = new Intl.DisplayNames([language], { type: 'region' }); } catch { countryNames = null; }
    const countryName = (code) => (code && countryNames ? countryNames.of(code) || code : code || '');
    const numberFormat = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
    const formatCredits = (value) => (value === null || value === undefined || value === '' ? '—' : numberFormat.format(Number(value)));
    const creditSystemName = (course) => (course.credit_system === 'OTHER' && course.credit_system_other
        ? course.credit_system_other
        : course.credit_system ? t(`student_credit_system_${course.credit_system}`) : '');
    const institutionLabel = (inst) => (inst ? `${inst.name}${inst.country ? ` (${countryName(inst.country)})` : ''}` : '');

    const { student, target_course: target, fulfilled_courses: courses, institutions, files } = details;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '12px', borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px' }}>
                <section style={box}>
                    <h4 style={sectionTitle}>{t('reviewer_details_student')}</h4>
                    <div><strong>{student.name}</strong></div>
                    <div style={muted}>{t('reviewer_details_neptun', { code: student.neptun_code || '—' })}</div>
                    <div style={muted}>{t('reviewer_details_programme', { programme: programmeName(student.programme, i18n) })}</div>
                </section>
                <section style={box}>
                    <h4 style={sectionTitle}>{t('reviewer_details_target')}</h4>
                    <div><strong>{target.course_code}</strong>{target.course_name ? ` – ${target.course_name}` : ''}</div>
                    <div style={muted}>{t('reviewer_details_target_credits', { credits: formatCredits(target.credits) })}</div>
                </section>
            </div>

            <section>
                <h4 style={sectionTitle}>{t('reviewer_details_fulfilled')}</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {courses.map((course, idx) => (
                        <div key={idx} style={box}>
                            <div>
                                <strong>{course.course_name}</strong>
                                {course.course_code ? <span style={muted}> ({course.course_code})</span> : null}
                            </div>
                            <div style={muted}>
                                {t('reviewer_details_course_line', { credits: formatCredits(course.credits), system: creditSystemName(course), grade: course.grade || '—' })}
                            </div>
                            {institutions[course.institution] && (
                                <div style={muted}>{t('reviewer_details_institution', { institution: institutionLabel(institutions[course.institution]) })}</div>
                            )}
                            <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {course.file
                                    ? <FileLink fileName={course.file} info={files[course.file]} label={t('reviewer_transcript')} />
                                    : <div style={{ fontSize: '14px', color: 'var(--error-text)' }}>{t('reviewer_no_transcript')}</div>}
                                {course.syllabus_file && <FileLink fileName={course.syllabus_file} info={files[course.syllabus_file]} label={t('reviewer_syllabus')} />}
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            {institutions.length > 0 && (
                <section>
                    <h4 style={sectionTitle}>{t('reviewer_details_institutions')}</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {institutions.map((inst, idx) => (
                            <div key={idx} style={box}>
                                <div><strong>{institutionLabel(inst)}</strong></div>
                                {inst.grading_file
                                    ? <FileLink fileName={inst.grading_file} info={files[inst.grading_file]} label={t('reviewer_grading_system')} />
                                    : <div style={muted}>{t('reviewer_no_grading_file')}</div>}
                            </div>
                        ))}
                    </div>
                </section>
            )}

            <section style={box}>
                <h4 style={sectionTitle}>{t('reviewer_credits_heading')}</h4>
                <CreditComparison courses={courses} requiredCredits={target.credits} formatCredits={formatCredits} creditSystemName={creditSystemName} />
            </section>

            <section>
                <h4 style={sectionTitle}>{t('reviewer_notes_heading')}</h4>
                <NotesConversation events={details.events} files={files} />
                {/* Reply files from before the history kept them with their reply */}
                {details.extra_files.length > 0 && (
                    <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <strong style={{ fontSize: '14px' }}>📎 {t('reviewer_additional_evidence')}</strong>
                        {details.extra_files.map((file, idx) => (
                            <FileLink key={file} fileName={file} info={files[file]} label={t('reviewer_additional_file', { number: idx + 1 })} />
                        ))}
                    </div>
                )}
                <div style={{ marginTop: '14px' }}>
                    <HistoryTable events={details.events} />
                </div>
            </section>

            {(details.status === 'approved' || details.status === 'rejected') && (
                <section style={box}>
                    <h4 style={sectionTitle}>{t('reviewer_decision_heading')}</h4>
                    <div>
                        <strong style={{ color: details.status === 'approved' ? 'var(--ok-text)' : 'var(--error-text)' }}>{t(`status_${details.status}`)}</strong>
                        {details.status === 'approved' && <> · {t('reviewer_grade_line', { grade: gradeText(details.decision.final_grade, t, language) })}</>}
                    </div>
                    <div style={muted}>
                        {t('reviewer_decided_line', {
                            date: details.decision.decided_at ? formatDate(details.decision.decided_at, language) : '—',
                            who: details.decision.decided_by_role === 'admin' ? t('reviewer_decided_by_admin')
                                : details.decision.decided_by_role === 'system' ? t('reviewer_decided_by_system')
                                    : details.decision.decided_by_name || '—',
                        })}
                    </div>
                    {/* An automatic rejection has only a reason code (reviewer Group 7), shown in the reader's language */}
                    {(details.decision.reason_code || details.decision.rationale) && (
                        <div style={{ marginTop: '6px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                            <strong>{t(details.status === 'approved' ? 'reviewer_decision_note_label' : 'reviewer_decision_reason_label')}</strong>{' '}
                            {details.decision.reason_code
                                ? t(`student_reason_${details.decision.reason_code}`, { defaultValue: details.decision.rationale || '' })
                                : details.decision.rationale}
                        </div>
                    )}
                </section>
            )}

            {details.status === 'needs_info' && details.respond_by && (
                <p role="note" style={{ margin: 0, padding: '8px 10px', borderRadius: '5px', backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)' }}>
                    {t('reviewer_waiting_for_student', { date: formatDate(details.respond_by, language) })}
                </p>
            )}

            {/* Only a pending application can be decided (utils/decisions.js on the server) */}
            {details.status === 'pending' && (
                <section style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    <button type="button" onClick={() => onDecide('approved')} style={{ backgroundColor: 'var(--brand)', color: 'white', cursor: 'pointer', padding: '8px 14px', border: '1px solid var(--brand)', borderRadius: '4px', fontWeight: 'bold' }}>{t('reviewer_approve')}</button>
                    <button type="button" onClick={() => onDecide('needs_info')} style={{ backgroundColor: 'var(--request)', color: 'white', cursor: 'pointer', padding: '8px 14px', border: '1px solid var(--request)', borderRadius: '4px', fontWeight: 'bold' }}>{t('reviewer_request_info')}</button>
                    <button type="button" onClick={() => onDecide('rejected')} style={{ backgroundColor: 'var(--surface)', color: 'var(--link)', cursor: 'pointer', padding: '8px 14px', border: '1px solid var(--link)', borderRadius: '4px', fontWeight: 'bold' }}>{t('reviewer_reject')}</button>
                </section>
            )}
        </div>
    );
};

export default ApplicationDetails;
