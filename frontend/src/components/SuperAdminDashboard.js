import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useTranslation } from 'react-i18next';

const SuperAdminDashboard = () => {
    const { t } = useTranslation();
    const [systemUsers, setSystemUsers] = useState([]);
    const [applications, setApplications] = useState([]);

    const [studentSearch, setStudentSearch] = useState('');
    const [reviewerSearch, setReviewerSearch] = useState('');
    
    const [showStudentDropdown, setShowStudentDropdown] = useState(false);
    const [showReviewerDropdown, setShowReviewerDropdown] = useState(false);

    const [isSystemOpen, setIsSystemOpen] = useState(true);

    // --- NEW: Role Management State ---
    const [allUsers, setAllUsers] = useState([]);
    const [roleUpdateStatus, setRoleUpdateStatus] = useState('');

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

    // --- NEW: Fetch full user list including superadmins ---
    const fetchAllUsers = useCallback(async () => {
        try {
            const res = await api.get('/api/users/all');
            if (res.data.success) setAllUsers(res.data.users);
        } catch (err) { console.error('Error fetching all users', err); }
    }, []);

    useEffect(() => {
        fetchSystemUsers();
        fetchApplications();
        fetchSystemStatus();
        fetchAllUsers();
    }, [fetchSystemUsers, fetchApplications, fetchSystemStatus, fetchAllUsers]);

    // --- Helper to safely parse the Phase 1 JSON array ---
    const parseCourses = (jsonStringOrArray) => {
        if (!jsonStringOrArray) return [];
        if (Array.isArray(jsonStringOrArray)) return jsonStringOrArray;
        try { return JSON.parse(jsonStringOrArray); } catch (e) { return []; }
    };

    const handleImpersonateSpecificUser = (user) => {
        localStorage.setItem('originalRole', 'superadmin');
        localStorage.setItem('impersonatedRole', user.role);
        localStorage.setItem('impersonatedUserId', user.id);
        localStorage.setItem('impersonatedName', user.name);
        window.location.reload();
    };

    const handleUpdateStatus = async (appId, newStatus) => {
        try {
            const res = await api.put(`/api/applications/${appId}/status`, { status: newStatus, note: t('superadmin_system_override_note') });
            if (res.data.success) { 
                alert(t('superadmin_update_success', { status: t(`status_${newStatus}`) })); 
                fetchApplications(); 
            }
        } catch (err) { alert(t('superadmin_update_failed')); }
    };

    const handleToggleSystem = async () => {
        const confirmMsg = isSystemOpen 
            ? t('superadmin_confirm_close') 
            : t('superadmin_confirm_open');
        
        if (window.confirm(confirmMsg)) {
            try {
                const res = await api.put('/api/settings/toggle', { isOpen: !isSystemOpen });
                if (res.data.success) setIsSystemOpen(res.data.isOpen);
            } catch (err) { alert(t('superadmin_toggle_failed')); }
        }
    };

    // --- NEW: Handle a role change from the dropdown ---
    const handleRoleChange = async (user, newRole) => {
        if (newRole === user.role) return; // no actual change

        // Extra confirmation specifically for promoting someone TO superadmin
        if (newRole === 'superadmin') {
            const confirmed = window.confirm(
                `Are you sure you want to make ${user.name} a Super Admin? This grants them full control over the entire system.`
            );
            if (!confirmed) return;
        } else {
            // Normal confirmation for other role changes
            const confirmed = window.confirm(`Change ${user.name}'s role from ${user.role} to ${newRole}?`);
            if (!confirmed) return;
        }

        try {
            setRoleUpdateStatus('Updating role...');
            const res = await api.put(`/api/users/${user.id}/role`, { newRole });
            if (res.data.success) {
                setRoleUpdateStatus(`${user.name} is now ${newRole}.`);
                fetchAllUsers(); // refresh the list to show the change
                fetchSystemUsers(); // also refresh impersonation dropdowns in case role affects them
                setTimeout(() => setRoleUpdateStatus(''), 3000);
            }
        } catch (err) {
            // The backend sends a specific message (e.g. "Cannot remove the last remaining superadmin")
            const errorMsg = err.response?.data?.error || 'Failed to update role.';
            setRoleUpdateStatus(errorMsg);
            alert(errorMsg);
            setTimeout(() => setRoleUpdateStatus(''), 4000);
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
            <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px', border: '1px solid #ccc', boxShadow: '0 2px 5px rgba(0,0,0,0.05)' }}>
                <div>
                    <h2 style={{ margin: 0, color: isSystemOpen ? '#28a745' : '#dc3545' }}>
                        {isSystemOpen ? t('superadmin_window_open') : t('superadmin_window_closed')}
                    </h2>
                    <p style={{ margin: '5px 0 0 0', color: '#555' }}>
                        {isSystemOpen ? t('superadmin_window_open_body') : t('superadmin_window_closed_body')}
                    </p>
                </div>
                <button onClick={handleToggleSystem} style={{ padding: '12px 20px', fontSize: '15px', fontWeight: 'bold', cursor: 'pointer', backgroundColor: isSystemOpen ? '#dc3545' : '#28a745', color: 'white', border: 'none', borderRadius: '5px' }}>
                    {isSystemOpen ? t('superadmin_lock_system') : t('superadmin_unlock_system')}
                </button>
            </div>

            {/* Impersonation Engine */}
            <div style={{ backgroundColor: '#f8f9fa', padding: '20px', borderRadius: '10px', textAlign: 'center', marginBottom: '30px', border: '2px dashed #004085' }}>
                <h2 style={{ marginTop: 0, color: '#004085' }}>{t('superadmin_impersonate_title')}</h2>
                <p style={{ fontSize: '14px', color: '#666', marginBottom: '20px' }}>{t('superadmin_impersonate_description')}</p>
                
                <div style={{ display: 'flex', justifyContent: 'center', gap: '40px', flexWrap: 'wrap' }}>
                    {/* Student Impersonation */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', position: 'relative' }}>
                        <label style={{ fontWeight: 'bold', color: '#004085', marginBottom: '5px' }}>{t('superadmin_impersonate_student')}</label>
                        <input 
                            type="text" placeholder={t('superadmin_search_placeholder')} value={studentSearch} onChange={(e) => setStudentSearch(e.target.value)} onFocus={() => setShowStudentDropdown(true)} onBlur={() => setTimeout(() => setShowStudentDropdown(false), 200)}
                            style={{ width: '250px', padding: '10px', border: '1px solid #004085', borderRadius: '5px', boxSizing: 'border-box', fontSize: '14px', outline: 'none' }}
                        />
                        {showStudentDropdown && (
                            <div style={{ position: 'absolute', top: '70px', left: 0, width: '250px', maxHeight: '200px', overflowY: 'auto', backgroundColor: '#fff', border: '1px solid #004085', borderRadius: '5px', zIndex: 1000, boxShadow: '0 4px 8px rgba(0,0,0,0.1)' }}>
                                {filteredStudents.length === 0 ? <div style={{ padding: '10px', color: '#dc3545', fontSize: '13px', textAlign: 'center' }}>{t('superadmin_no_students')}</div> : (
                                    filteredStudents.map(user => (
                                        <div key={user.id} onClick={() => handleImpersonateSpecificUser(user)} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f0f8ff'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#fff'} style={{ padding: '10px', cursor: 'pointer', borderBottom: '1px solid #eee', textAlign: 'left' }}>
                                            <div style={{ fontWeight: 'bold', color: '#004085', fontSize: '14px' }}>{user.name}</div>
                                            <div style={{ color: '#666', fontSize: '11px' }}>{user.email}</div>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}
                    </div>

                    {/* Reviewer Impersonation */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', position: 'relative' }}>
                        <label style={{ fontWeight: 'bold', color: '#155724', marginBottom: '5px' }}>{t('superadmin_impersonate_reviewer')}</label>
                        <input 
                            type="text" placeholder={t('superadmin_search_placeholder')} value={reviewerSearch} onChange={(e) => setReviewerSearch(e.target.value)} onFocus={() => setShowReviewerDropdown(true)} onBlur={() => setTimeout(() => setShowReviewerDropdown(false), 200)}
                            style={{ width: '250px', padding: '10px', border: '1px solid #28a745', borderRadius: '5px', boxSizing: 'border-box', fontSize: '14px', outline: 'none' }}
                        />
                        {showReviewerDropdown && (
                            <div style={{ position: 'absolute', top: '70px', left: 0, width: '250px', maxHeight: '200px', overflowY: 'auto', backgroundColor: '#fff', border: '1px solid #28a745', borderRadius: '5px', zIndex: 1000, boxShadow: '0 4x 8px rgba(0,0,0,0.1)' }}>
                                {filteredReviewers.length === 0 ? <div style={{ padding: '10px', color: '#dc3545', fontSize: '13px', textAlign: 'center' }}>{t('superadmin_no_reviewers')}</div> : (
                                    filteredReviewers.map(user => (
                                        <div key={user.id} onClick={() => handleImpersonateSpecificUser(user)} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#e2f0d9'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#fff'} style={{ padding: '10px', cursor: 'pointer', borderBottom: '1px solid #eee', textAlign: 'left' }}>
                                            <div style={{ fontWeight: 'bold', color: '#155724', fontSize: '14px' }}>{user.name}</div>
                                            <div style={{ color: '#666', fontSize: '11px' }}>{user.email}</div>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* --- NEW: Role Management Engine --- */}
            <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '10px', border: '1px solid #6f42c1', marginBottom: '30px' }}>
                <h2 style={{ marginTop: 0, color: '#6f42c1' }}>Role Management</h2>
                <p style={{ fontSize: '14px', color: '#666', marginBottom: '15px' }}>
                    Change any user's role. Promoting someone to Super Admin requires extra confirmation.
                </p>

                {roleUpdateStatus && (
                    <div style={{ backgroundColor: '#e2e3f0', color: '#004085', padding: '10px', borderRadius: '5px', marginBottom: '15px', fontWeight: 'bold' }}>
                        {roleUpdateStatus}
                    </div>
                )}

                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={{ backgroundColor: '#6f42c1', color: 'white' }}>
                            <th style={{ padding: '10px', textAlign: 'left' }}>Name</th>
                            <th style={{ padding: '10px', textAlign: 'left' }}>Email</th>
                            <th style={{ padding: '10px', textAlign: 'center' }}>Current Role</th>
                            <th style={{ padding: '10px', textAlign: 'center' }}>Change Role To</th>
                        </tr>
                    </thead>
                    <tbody>
                        {allUsers.length === 0 ? (
                            <tr><td colSpan="4" style={{ textAlign: 'center', padding: '20px' }}>No users found.</td></tr>
                        ) : allUsers.map(user => (
                            <tr key={user.id} style={{ borderBottom: '1px solid #eee' }}>
                                <td style={{ padding: '10px' }}>{user.name}</td>
                                <td style={{ padding: '10px', color: '#555', fontSize: '13px' }}>{user.email}</td>
                                <td style={{ padding: '10px', textAlign: 'center' }}>
                                    <span style={{
                                        fontWeight: 'bold',
                                        padding: '4px 10px',
                                        borderRadius: '12px',
                                        fontSize: '12px',
                                        backgroundColor: user.role === 'superadmin' ? '#6f42c1' : user.role === 'reviewer' ? '#28a745' : '#007bff',
                                        color: 'white'
                                    }}>
                                        {user.role}
                                    </span>
                                </td>
                                <td style={{ padding: '10px', textAlign: 'center' }}>
                                    <select
                                        value={user.role}
                                        onChange={(e) => handleRoleChange(user, e.target.value)}
                                        style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid #ccc', cursor: 'pointer' }}
                                    >
                                        <option value="student">Student</option>
                                        <option value="reviewer">Reviewer</option>
                                        <option value="superadmin">Super Admin</option>
                                    </select>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Application Overrides Engine */}
            <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '10px', border: '1px solid #003d7c' }}>
                <h2 style={{ marginTop: 0, color: '#003d7c' }}>{t('superadmin_application_overrides_title')}</h2>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={{ backgroundColor: '#003d7c', color: 'white' }}>
                            <th style={{ padding: '12px', textAlign: 'left' }}>{t('superadmin_student_column')}</th>
                            <th style={{ padding: '12px', textAlign: 'left' }}>{t('superadmin_mapped_package_column')}</th>
                            <th style={{ padding: '12px', textAlign: 'center' }}>{t('superadmin_status_column')}</th>
                            <th style={{ padding: '12px', textAlign: 'center' }}>{t('superadmin_action_column')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {applications.length === 0 ? (
                            <tr><td colSpan="4" style={{ textAlign: 'center', padding: '20px' }}>{t('superadmin_no_applications')}</td></tr>
                        ) : applications.map(app => {
                            const coursesList = parseCourses(app.fulfilled_courses_json);
                            const fulfilledNames = coursesList.map(c => c.course_name).join(', ');

                            return (
                            <tr key={app.id} style={{ borderBottom: '1px solid #eee' }}>
                                <td style={{ padding: '12px', fontWeight: 'bold', verticalAlign: 'top' }}>{app.student_name}</td>
                                <td style={{ padding: '12px', color: '#333', fontSize: '13px', verticalAlign: 'top' }}>
                                    <div style={{ marginBottom: '5px' }}>
                                        <strong style={{ color: '#004085' }}>From:</strong> {fulfilledNames || 'N/A'}
                                    </div>
                                    <div>
                                        <strong style={{ color: '#28a745' }}>To:</strong> {app.pte_course_names && app.pte_course_names.length > 50 ? `${app.pte_course_names.substring(0, 50)}...` : app.pte_course_names}
                                    </div>
                                </td>
                                <td style={{ padding: '12px', textAlign: 'center', verticalAlign: 'top' }}>
                                    <span style={{ 
                                        fontWeight: 'bold', 
                                        padding: '4px 8px', 
                                        borderRadius: '4px',
                                        backgroundColor: app.status === 'approved' ? '#d4edda' : app.status === 'rejected' ? '#f8d7da' : '#fff3cd',
                                        color: app.status === 'approved' ? '#155724' : app.status === 'rejected' ? '#721c24' : '#856404' 
                                    }}>
                                        {t(`status_${app.status}`)}
                                    </span>
                                </td>
                                <td style={{ padding: '12px', textAlign: 'center', verticalAlign: 'top' }}>
                                    <button onClick={() => handleUpdateStatus(app.id, 'pending')} style={{ cursor: 'pointer', padding: '6px 12px', backgroundColor: '#ffc107', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>{t('superadmin_reset_button')}</button>
                                    <button onClick={() => handleUpdateStatus(app.id, 'approved')} style={{ cursor: 'pointer', marginLeft: '8px', padding: '6px 12px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>{t('superadmin_force_approve_button')}</button>
                                </td>
                            </tr>
                        )})}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default SuperAdminDashboard;