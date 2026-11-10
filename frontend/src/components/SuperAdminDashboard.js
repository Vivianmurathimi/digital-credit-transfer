import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useTranslation } from 'react-i18next';
import { getErrorMessage } from '../errorMessage';
import TermArchive from './TermArchive';
import ReviewerOverview from './ReviewerOverview';
import { startActing } from '../acting';
import { formatDateTime } from '../dates';
import StaffAccess from './StaffAccess';
import AllowedDomains from './AllowedDomains';
import StudentProgrammes from './StudentProgrammes';
import SemesterCatalogue from './admin/SemesterCatalogue';
import DecisionModal from './reviewer/DecisionModal';
import Chip from './reviewer/Chip';

// The admin's decision buttons (admin round Group 2): only for pending applications of a programme
// with no active reviewer. Same panel and rules as the reviewer's; recorded as Admin.
const DECIDE_TYPES = [['approved', 'approve', 'reviewer_approve'], ['needs_info', 'info', 'reviewer_request_info'], ['rejected', 'reject', 'reviewer_reject']];
const OPEN_STATUSES = ['pending', 'needs_info'];

// onActingStarted: called once the session is the person's (Dashboard then shows their screen)
const SuperAdminDashboard = ({ onActingStarted }) => {
    const { t, i18n } = useTranslation();
    const [systemUsers, setSystemUsers] = useState([]);
    const [applications, setApplications] = useState([]);

    const [studentSearch, setStudentSearch] = useState('');
    const [reviewerSearch, setReviewerSearch] = useState('');
    
    const [showStudentDropdown, setShowStudentDropdown] = useState(false);
    const [showReviewerDropdown, setShowReviewerDropdown] = useState(false);

    const [isSystemOpen, setIsSystemOpen] = useState(true);

    const [decision, setDecision] = useState(null); // { app, type } while the decision panel is open
    const [decisionNotice, setDecisionNotice] = useState('');

    const fetchSystemUsers = useCallback(async () => {
        try {
            const res = await api.get('/api/users');
            if (res.data.success) {
                setSystemUsers(res.data.users);
            }
        } catch (err) { console.error('Error fetching users', err); }
    }, []);

    const fetchApplications = useCallback(async () => {
        try {
            const res = await api.get('/api/applications');
            if (res.data.success) setApplications(res.data.applications);
        } catch (err) { console.error('Error fetching apps', err); }
    }, []);

    const fetchSystemStatus = useCallback(async () => {
        try {
            const res = await api.get('/api/settings/status');
            if (res.data.success) setIsSystemOpen(res.data.isOpen);
        } catch (err) { console.error('Error fetching system status', err); }
    }, []);

    useEffect(() => {
        fetchSystemUsers();
        fetchApplications();
        fetchSystemStatus();
    }, [fetchSystemUsers, fetchApplications, fetchSystemStatus]);

    // --- Helper to safely parse the Phase 1 JSON array ---
    const parseCourses = (jsonStringOrArray) => {
        if (!jsonStringOrArray) return [];
        if (Array.isArray(jsonStringOrArray)) return jsonStringOrArray;
        try { return JSON.parse(jsonStringOrArray); } catch (e) { return []; }
    };

    // Acting as a student or reviewer (admin round Group 1): the server starts the session and
    // records it; everything done in it is saved as Admin
    const handleActAs = async (user) => {
        if (user.deactivated) return;
        try {
            await startActing(user.id);
            onActingStarted();
        } catch (err) {
            alert(getErrorMessage(err, t, 'acting_start_failed'));
        }
    };

    // "Reviewer: <name>", "Admin" or "System", with the date; "—" for older rows without a record
    const decidedBy = (app) => {
        if (!app.decided_by_role) return '—';
        const who = app.decided_by_role === 'reviewer'
            ? t('superadmin_decided_by_reviewer', { name: app.decided_by_name || '—' })
            : t(`reviewer_decided_by_${app.decided_by_role}`);
        return app.decided_at ? `${who}, ${formatDateTime(app.decided_at, i18n.language)}` : who;
    };

    const handleUpdateStatus = async (appId, newStatus) => {
        try {
            // No note: the reviewer's note stays, and the student sees the decision as made by "Admin"
            const res = await api.put(`/api/applications/${appId}/status`, { status: newStatus });
            if (res.data.success) { 
                alert(t('superadmin_update_success', { status: t(`status_${newStatus}`) })); 
                fetchApplications(); 
            }
        } catch (err) { alert(getErrorMessage(err, t, 'superadmin_update_failed')); }
    };

    const handleToggleSystem = async () => {
        const confirmMsg = isSystemOpen 
            ? t('superadmin_confirm_close') 
            : t('superadmin_confirm_open');
        
        if (window.confirm(confirmMsg)) {
            try {
                const res = await api.put('/api/settings/toggle', { isOpen: !isSystemOpen });
                if (res.data.success) setIsSystemOpen(res.data.isOpen);
            } catch (err) { alert(getErrorMessage(err, t, 'superadmin_toggle_failed')); }
        }
    };

    const filteredStudents = systemUsers.filter(u => 
        u.role === 'student' && (u.name.toLowerCase().includes(studentSearch.toLowerCase()) || u.email.toLowerCase().includes(studentSearch.toLowerCase()))
    );

    const filteredReviewers = systemUsers.filter(u => 
        u.role === 'reviewer' && (u.name.toLowerCase().includes(reviewerSearch.toLowerCase()) || u.email.toLowerCase().includes(reviewerSearch.toLowerCase()))
    );

    return (
        <div style={{ marginTop: '10px' }}>
            {/* System Status Banner */}
            <div style={{ backgroundColor: 'var(--surface)', padding: '20px', borderRadius: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px', border: '2px solid var(--border-strong)', boxShadow: '0 2px 5px rgba(0,0,0,0.05)' }}>
                <div>
                    <h2 style={{ margin: 0, color: isSystemOpen ? 'var(--success-accent)' : 'var(--danger-accent)' }}>
                        {isSystemOpen ? t('superadmin_window_open') : t('superadmin_window_closed')}
                    </h2>
                    <p style={{ margin: '5px 0 0 0', color: 'var(--text-secondary)' }}>
                        {isSystemOpen ? t('superadmin_window_open_body') : t('superadmin_window_closed_body')}
                    </p>
                </div>
                <button onClick={handleToggleSystem} style={{ padding: '12px 20px', fontSize: '15px', fontWeight: 'bold', cursor: 'pointer', backgroundColor: isSystemOpen ? 'var(--red)' : 'var(--accent)', color: 'white', border: 'none', borderRadius: '5px' }}>
                    {isSystemOpen ? t('superadmin_lock_system') : t('superadmin_unlock_system')}
                </button>
            </div>

            {/* Pending applications and reviewers per programme (reviewer Group 7) */}
            <ReviewerOverview />

            {/* Allowed email domains for student registration, warns when empty (admin round Group 3) */}
            <AllowedDomains />

            {/* Semesters, the Neptun import, Programmes & Courses (admin round Group 4) */}
            <SemesterCatalogue />

            {/* Act as a student or reviewer (admin round Group 1) */}
            <div style={{ backgroundColor: 'var(--surface-2)', padding: '20px', borderRadius: '10px', textAlign: 'center', marginBottom: '30px', border: '3px dashed var(--link)' }}>
                <h2 style={{ marginTop: 0, color: 'var(--link)' }}>{t('superadmin_act_as_title')}</h2>
                <p style={{ fontSize: '14px', color: 'var(--text-muted)', marginBottom: '20px' }}>{t('superadmin_act_as_description')}</p>
                
                <div style={{ display: 'flex', justifyContent: 'center', gap: '40px', flexWrap: 'wrap' }}>
                    {/* Act as a student */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', position: 'relative' }}>
                        <label style={{ fontWeight: 'bold', color: 'var(--link)', marginBottom: '5px' }}>{t('superadmin_act_as_student')}</label>
                        <input 
                            type="text" placeholder={t('superadmin_search_placeholder')} value={studentSearch} onChange={(e) => setStudentSearch(e.target.value)} onFocus={() => setShowStudentDropdown(true)} onBlur={() => setTimeout(() => setShowStudentDropdown(false), 200)}
                            style={{ width: '250px', padding: '10px', border: '1px solid var(--link)', borderRadius: '5px', boxSizing: 'border-box', fontSize: '14px', outline: 'none' }}
                        />
                        {showStudentDropdown && (
                            <div style={{ position: 'absolute', top: '70px', left: 0, width: '250px', maxHeight: '200px', overflowY: 'auto', backgroundColor: 'var(--surface)', border: '1px solid var(--link)', borderRadius: '5px', zIndex: 1000, boxShadow: '0 4px 8px rgba(0,0,0,0.1)' }}>
                                {filteredStudents.length === 0 ? <div style={{ padding: '10px', color: 'var(--danger-accent)', fontSize: '13px', textAlign: 'center' }}>{t('superadmin_no_students')}</div> : (
                                    filteredStudents.map(user => (
                                        <div key={user.id} onClick={() => handleActAs(user)} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--hover-info)'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'var(--surface)'} style={{ padding: '10px', cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)', textAlign: 'left' }}>
                                            <div style={{ fontWeight: 'bold', color: 'var(--link)', fontSize: '14px' }}>{user.name}</div>
                                            <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{user.email}</div>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}
                    </div>

                    {/* Act as a reviewer */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', position: 'relative' }}>
                        <label style={{ fontWeight: 'bold', color: 'var(--success-text)', marginBottom: '5px' }}>{t('superadmin_act_as_reviewer')}</label>
                        <input 
                            type="text" placeholder={t('superadmin_search_placeholder')} value={reviewerSearch} onChange={(e) => setReviewerSearch(e.target.value)} onFocus={() => setShowReviewerDropdown(true)} onBlur={() => setTimeout(() => setShowReviewerDropdown(false), 200)}
                            style={{ width: '250px', padding: '10px', border: '1px solid var(--accent)', borderRadius: '5px', boxSizing: 'border-box', fontSize: '14px', outline: 'none' }}
                        />
                        {showReviewerDropdown && (
                            <div style={{ position: 'absolute', top: '70px', left: 0, width: '250px', maxHeight: '200px', overflowY: 'auto', backgroundColor: 'var(--surface)', border: '1px solid var(--accent)', borderRadius: '5px', zIndex: 1000, boxShadow: '0 4x 8px rgba(0,0,0,0.1)' }}>
                                {filteredReviewers.length === 0 ? <div style={{ padding: '10px', color: 'var(--danger-accent)', fontSize: '13px', textAlign: 'center' }}>{t('superadmin_no_reviewers')}</div> : (
                                    filteredReviewers.map(user => (
                                        <div key={user.id} onClick={() => handleActAs(user)} aria-disabled={user.deactivated || undefined} onMouseEnter={(e) => { if (!user.deactivated) e.currentTarget.style.backgroundColor = 'var(--success-surface)'; }} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'var(--surface)'} style={{ padding: '10px', cursor: user.deactivated ? 'not-allowed' : 'pointer', opacity: user.deactivated ? 0.55 : 1, borderBottom: '1px solid var(--border-subtle)', textAlign: 'left' }}>
                                            <div style={{ fontWeight: 'bold', color: 'var(--success-text)', fontSize: '14px' }}>{user.name}{user.deactivated && ` (${t('superadmin_removed_reviewer')})`}</div>
                                            <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{user.email}</div>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Reviewers and admins: invites, removal, deactivation (admin round Group 2) */}
            <StaffAccess />

            {/* Students: search, fix a student's programme (admin round Group 3) */}
            <StudentProgrammes />

            {/* Application Overrides Engine */}
            <div style={{ backgroundColor: 'var(--surface)', padding: '20px', borderRadius: '10px', border: '2px solid var(--heading)' }}>
                <h2 style={{ marginTop: 0, color: 'var(--heading)' }}>{t('superadmin_application_overrides_title')}</h2>
                {decisionNotice && <p role="status" style={{ color: 'var(--success-text)', fontWeight: 'bold' }}>{decisionNotice}</p>}
                <table style={{ width: '100%', borderCollapse: 'collapse', border: '2px solid var(--border)' }}>
                    <thead>
                        <tr style={{ backgroundColor: 'var(--header-bg)', color: 'white' }}>
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
                        ) : applications.map(app => {
                            const coursesList = parseCourses(app.fulfilled_courses_json);
                            const fulfilledNames = coursesList.map(c => c.course_name).join(', ');

                            return (
                            <tr key={app.id} style={{ borderBottom: '2px solid var(--border)' }}>
                                <td style={{ padding: '12px', fontWeight: 'bold', verticalAlign: 'top' }}>
                                    {app.student_name}
                                    {!app.programme_has_reviewer && OPEN_STATUSES.includes(app.status) && (
                                        <div style={{ marginTop: '6px' }}><Chip cue="rejected">{t('superadmin_no_reviewer')}</Chip></div>
                                    )}
                                </td>
                                <td style={{ padding: '12px', color: 'var(--text-strong)', fontSize: '13px', verticalAlign: 'top' }}>
                                    <div style={{ marginBottom: '5px' }}>
                                        <strong style={{ color: 'var(--link)' }}>From:</strong> {fulfilledNames || 'N/A'}
                                    </div>
                                    <div>
                                        <strong style={{ color: 'var(--success-accent)' }}>To:</strong> {app.pte_course_names && app.pte_course_names.length > 50 ? `${app.pte_course_names.substring(0, 50)}...` : app.pte_course_names}
                                    </div>
                                </td>
                                <td style={{ padding: '12px', textAlign: 'center', verticalAlign: 'top' }}>
                                    <span style={{ 
                                        fontWeight: 'bold', 
                                        padding: '4px 8px', 
                                        borderRadius: '4px',
                                        backgroundColor: app.status === 'approved' ? 'var(--success-bg)' : app.status === 'rejected' ? 'var(--danger-bg)' : app.status === 'needs_info' ? 'var(--warning-bg)' : 'var(--info-bg)',
                                        color: app.status === 'approved' ? 'var(--success-text)' : app.status === 'rejected' ? 'var(--danger-text)' : app.status === 'needs_info' ? 'var(--warning-text)' : 'var(--info-text)' 
                                    }}>
                                        {t(`status_${app.status}`)}
                                    </span>
                                </td>
                                <td style={{ padding: '12px', verticalAlign: 'top', fontSize: '13px' }}>{decidedBy(app)}</td>
                                <td style={{ padding: '12px', textAlign: 'center', verticalAlign: 'top' }}>
                                    {/* No active reviewer for this programme: the admin decides (recorded as Admin) */}
                                    {app.status === 'pending' && !app.programme_has_reviewer && (
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'center', marginBottom: '8px' }}>
                                            {DECIDE_TYPES.map(([type, cue, labelKey]) => (
                                                <button key={type} type="button" onClick={() => { setDecisionNotice(''); setDecision({ app, type }); }}
                                                    style={{ padding: '6px 12px', backgroundColor: `var(--cue-btn-${cue})`, color: `var(--cue-btn-${cue}-text)`, border: 'none', borderRadius: '4px', fontWeight: 'bold', cursor: 'pointer' }}>
                                                    {t(labelKey)}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    {/* Reset and force approve break the decision rules (reviewer Group 6: approvals need a
                                        grade, decided applications are final). Disabled until the admin round rebuilds them
                                        as admin overrides; handleUpdateStatus is kept for that. The tooltip sits on a wrapper,
                                        because disabled buttons don't show one in every browser. */}
                                    <span title={t('superadmin_override_coming_soon')} style={{ display: 'inline-block' }}>
                                        <button type="button" disabled aria-disabled="true" aria-label={`${t('superadmin_reset_button')} – ${t('superadmin_override_coming_soon')}`} onClick={() => handleUpdateStatus(app.id, 'pending')} style={{ cursor: 'not-allowed', opacity: 0.5, padding: '6px 12px', backgroundColor: 'var(--request)', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold', pointerEvents: 'none' }}>{t('superadmin_reset_button')}</button>
                                    </span>
                                    <span title={t('superadmin_override_coming_soon')} style={{ display: 'inline-block', marginLeft: '8px' }}>
                                        <button type="button" disabled aria-disabled="true" aria-label={`${t('superadmin_force_approve_button')} – ${t('superadmin_override_coming_soon')}`} onClick={() => handleUpdateStatus(app.id, 'approved')} style={{ cursor: 'not-allowed', opacity: 0.5, padding: '6px 12px', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold', pointerEvents: 'none' }}>{t('superadmin_force_approve_button')}</button>
                                    </span>
                                </td>
                            </tr>
                        )})}
                    </tbody>
                </table>
            </div>

            {decision && (
                <DecisionModal
                    app={decision.app} type={decision.type}
                    onClose={() => setDecision(null)}
                    onDone={(saved) => {
                        setDecision(null);
                        setDecisionNotice(saved ? t('reviewer_decision_saved') : '');
                        fetchApplications();
                    }}
                />
            )}

            {/* Term Archive: semester PDF books for audits */}
            <TermArchive />
        </div>
    );
};

export default SuperAdminDashboard;