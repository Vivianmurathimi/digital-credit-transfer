import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../../api';
import { getErrorMessage, unpackBlobError } from '../../errorMessage';
import downloadPdf from '../../downloadPdf';
import { formatDateTime } from '../../dates';
import DecisionModal from '../reviewer/DecisionModal';
import Chip from '../reviewer/Chip';
import StatusChip from '../StatusChip';
import { card } from './adminStyles';

// The Applications section of the admin menu (admin round Group 5; built in Groups 1 and 2):
// every application with who decided it, the overrides as before, and the Decide buttons for
// pending applications of a programme with no active reviewer (recorded as Admin). The semesters in
// progress (round 2 Group 1: several at once; a filter picks one); closed ones are in Past
// semesters, with the term book.

const DECIDE_TYPES = [['approved', 'approve', 'reviewer_approve'], ['needs_info', 'info', 'reviewer_request_info'], ['rejected', 'reject', 'reviewer_reject']];
const OPEN_STATUSES = ['pending', 'needs_info'];

const parseCourses = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try { return JSON.parse(value); } catch { return []; }
};

const ApplicationsSection = ({ onChange = () => {} }) => {
    const { t, i18n } = useTranslation();
    const [applications, setApplications] = useState([]);
    const [decision, setDecision] = useState(null); // { app, type } while the decision panel is open
    const [notice, setNotice] = useState('');
    const [semesters, setSemesters] = useState([]); // the semesters in progress, for the filter
    const [semesterId, setSemesterId] = useState(''); // '' = all in progress
    const [pdfError, setPdfError] = useState('');
    // One application as a PDF (round 2 Group 1), the same pages as in the book
    const savePdf = async (app) => {
        setPdfError('');
        try { await downloadPdf(`admin/applications/${app.id}/pdf`, `application_${app.id}.pdf`); }
        catch (err) { setPdfError(getErrorMessage(await unpackBlobError(err), t, 'pdf_download_failed')); }
    };

    const fetchApplications = useCallback(async () => {
        try {
            const res = await api.get('/api/applications', { params: semesterId ? { semester_id: semesterId } : {} });
            if (res.data.success) setApplications(res.data.applications);
        } catch (err) { console.error('Error fetching apps', err); }
    }, [semesterId]);
    useEffect(() => { fetchApplications(); }, [fetchApplications]);
    useEffect(() => {
        api.get('/api/admin/summary').then((res) => setSemesters(res.data.summary?.semesters || [])).catch(() => setSemesters([]));
    }, []);

    // "Reviewer: <name>", "Admin" or "System", with the date; "—" for older rows without a record
    const decidedBy = (app) => {
        if (!app.decided_by_role) return '—';
        const who = app.decided_by_role === 'reviewer'
            ? t('superadmin_decided_by_reviewer', { name: app.decided_by_name || '—' })
            : t(`reviewer_decided_by_${app.decided_by_role}`);
        return app.decided_at ? `${who}, ${formatDateTime(app.decided_at, i18n.language)}` : who;
    };

    // Kept for the future admin overrides (their buttons are disabled, see below)
    const handleUpdateStatus = async (appId, newStatus) => {
        try {
            const res = await api.put(`/api/applications/${appId}/status`, { status: newStatus });
            if (res.data.success) {
                alert(t('superadmin_update_success', { status: t(`status_${newStatus}`) }));
                fetchApplications();
            }
        } catch (err) { alert(getErrorMessage(err, t, 'superadmin_update_failed')); }
    };

    return (
        <>
            <section aria-labelledby="applications-title" style={{ ...card, border: '2px solid var(--heading)' }}>
                <h2 id="applications-title" style={{ marginTop: 0, color: 'var(--heading)' }}>{t('superadmin_application_overrides_title')}</h2>
                {/* The semesters in progress only (closed ones: Past semesters) */}
                <p style={{ marginTop: 0 }}>{t('applications_past_hint')} <Link to="/admin/past-semesters" style={{ color: 'var(--link)', fontWeight: 'bold' }}>{t('admin_menu_past_semesters')}</Link></p>
                {semesters.length > 1 && (
                    <p>
                        <label htmlFor="applications-semester">{t('import_semester_label')} </label>
                        <select id="applications-semester" value={semesterId} onChange={(e) => setSemesterId(e.target.value)} style={{ padding: '6px' }}>
                            <option value="">{t('applications_all_in_progress')}</option>
                            {semesters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                    </p>
                )}
                {notice && <p role="status" style={{ color: 'var(--success-text)', fontWeight: 'bold' }}>{notice}</p>}
                {pdfError && <p role="alert" style={{ color: 'var(--error-text)' }}>{pdfError}</p>}
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', border: '2px solid var(--border)' }}>
                        <thead>
                            <tr style={{ backgroundColor: 'var(--header-bg)', color: 'var(--text-on-primary)' }}>
                                <th style={{ padding: '12px', textAlign: 'left' }}>{t('superadmin_student_column')}</th>
                                <th style={{ padding: '12px', textAlign: 'left' }}>{t('superadmin_mapped_package_column')}</th>
                                <th style={{ padding: '12px', textAlign: 'center' }}>{t('superadmin_status_column')}</th>
                                <th style={{ padding: '12px', textAlign: 'left' }}>{t('superadmin_decided_by_column')}</th>
                                <th style={{ padding: '12px', textAlign: 'center' }}>{t('superadmin_action_column')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {applications.length === 0 ? (
                                <tr><td colSpan="5" style={{ textAlign: 'center', padding: '20px' }}>{t('superadmin_no_applications')}</td></tr>
                            ) : applications.map((app) => {
                                const fulfilledNames = parseCourses(app.fulfilled_courses_json).map((c) => c.course_name).join(', ');
                                return (
                                    <tr key={app.id} style={{ borderBottom: '2px solid var(--border)' }}>
                                        <td style={{ padding: '12px', fontWeight: 'bold', verticalAlign: 'top' }}>
                                            {app.student_name}
                                            {!app.programme_has_reviewer && OPEN_STATUSES.includes(app.status) && (
                                                <div style={{ marginTop: '6px' }}><Chip cue="rejected">{t('superadmin_no_reviewer')}</Chip></div>
                                            )}
                                        </td>
                                        <td style={{ padding: '12px', color: 'var(--text-strong)', fontSize: '13px', verticalAlign: 'top' }}>
                                            <div style={{ marginBottom: '5px' }}><strong style={{ color: 'var(--link)' }}>{t('superadmin_from_label')}</strong> {fulfilledNames || '—'}</div>
                                            <div><strong style={{ color: 'var(--success-accent)' }}>{t('superadmin_to_label')}</strong> {app.pte_course_names && app.pte_course_names.length > 50 ? `${app.pte_course_names.substring(0, 50)}...` : app.pte_course_names}</div>
                                        </td>
                                        <td style={{ padding: '12px', textAlign: 'center', verticalAlign: 'top' }}>
                                            <StatusChip status={app.status}>{t(`status_${app.status}`)}</StatusChip>
                                        </td>
                                        <td style={{ padding: '12px', verticalAlign: 'top', fontSize: '13px' }}>
                                            {decidedBy(app)}
                                            <div style={{ marginTop: '6px' }}>
                                                <button type="button" onClick={() => savePdf(app)} aria-label={t('pdf_download_application_of', { id: app.id })}
                                                    style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--border-strong)', backgroundColor: 'var(--surface)', color: 'var(--link)', cursor: 'pointer', font: 'inherit', fontSize: '12px' }}>
                                                    {t('pdf_download_application')}
                                                </button>
                                            </div>
                                        </td>
                                        <td style={{ padding: '12px', textAlign: 'center', verticalAlign: 'top' }}>
                                            {/* No active reviewer for this programme: the admin decides (recorded as Admin) */}
                                            {app.status === 'pending' && !app.programme_has_reviewer && (
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'center', marginBottom: '8px' }}>
                                                    {DECIDE_TYPES.map(([type, cue, labelKey]) => (
                                                        <button key={type} type="button" onClick={() => { setNotice(''); setDecision({ app, type }); }}
                                                            style={{ padding: '6px 12px', backgroundColor: `var(--cue-btn-${cue})`, color: `var(--cue-btn-${cue}-text)`, border: 'none', borderRadius: '4px', fontWeight: 'bold', cursor: 'pointer' }}>
                                                            {t(labelKey)}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                            {/* Reset and force approve break the decision rules (approvals need a grade, decided
                                                applications are final): disabled until they are rebuilt as admin overrides. The
                                                tooltip sits on a wrapper, because disabled buttons don't show one in every browser. */}
                                            <span title={t('superadmin_override_coming_soon')} style={{ display: 'inline-block' }}>
                                                <button type="button" disabled aria-disabled="true" aria-label={`${t('superadmin_reset_button')} – ${t('superadmin_override_coming_soon')}`} onClick={() => handleUpdateStatus(app.id, 'pending')} style={{ cursor: 'not-allowed', opacity: 0.5, padding: '6px 12px', backgroundColor: 'var(--request)', color: 'var(--text-on-primary)', border: 'none', borderRadius: '4px', fontWeight: 'bold', pointerEvents: 'none' }}>{t('superadmin_reset_button')}</button>
                                            </span>
                                            <span title={t('superadmin_override_coming_soon')} style={{ display: 'inline-block', marginLeft: '8px' }}>
                                                <button type="button" disabled aria-disabled="true" aria-label={`${t('superadmin_force_approve_button')} – ${t('superadmin_override_coming_soon')}`} onClick={() => handleUpdateStatus(app.id, 'approved')} style={{ cursor: 'not-allowed', opacity: 0.5, padding: '6px 12px', backgroundColor: 'var(--accent)', color: 'var(--text-on-primary)', border: 'none', borderRadius: '4px', fontWeight: 'bold', pointerEvents: 'none' }}>{t('superadmin_force_approve_button')}</button>
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </section>

            {decision && (
                <DecisionModal
                    app={decision.app} type={decision.type}
                    onClose={() => setDecision(null)}
                    onDone={(saved) => {
                        setDecision(null);
                        setNotice(saved ? t('reviewer_decision_saved') : '');
                        fetchApplications();
                        onChange();
                    }}
                />
            )}
        </>
    );
};

export default ApplicationsSection;
