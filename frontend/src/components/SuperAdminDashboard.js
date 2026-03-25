import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const SuperAdminDashboard = () => {
    const [systemUsers, setSystemUsers] = useState([]);
    const [applications, setApplications] = useState([]);

    const [studentSearch, setStudentSearch] = useState('');
    const [reviewerSearch, setReviewerSearch] = useState('');
    
    // 🆕 NEW STATES: Controls when the floating lists are visible
    const [showStudentDropdown, setShowStudentDropdown] = useState(false);
    const [showReviewerDropdown, setShowReviewerDropdown] = useState(false);

    const fetchSystemUsers = useCallback(async () => {
        try {
            const res = await axios.get('/api/users');
            if (res.data.success) {
                setSystemUsers(res.data.users);
            }
        } catch (err) { 
            console.error("Error fetching users", err); 
        }
    }, []);

    const fetchApplications = useCallback(async () => {
        try {
            const res = await axios.get('/api/applications');
            if (res.data.success) setApplications(res.data.applications);
        } catch (err) { 
            console.error("Error fetching apps", err); 
        }
    }, []);

    useEffect(() => {
        fetchSystemUsers();
        fetchApplications();
    }, [fetchSystemUsers, fetchApplications]);

    const handleImpersonateSpecificUser = (user) => {
        localStorage.setItem('originalRole', 'superadmin');
        localStorage.setItem('impersonatedRole', user.role);
        localStorage.setItem('impersonatedUserId', user.id);
        localStorage.setItem('impersonatedName', user.name);
        window.location.reload();
    };

    const handleUpdateStatus = async (appId, newStatus) => {
        try {
            const res = await axios.put(`/api/applications/${appId}/status`, { 
                status: newStatus, 
                note: 'System Override by Super Admin' 
            });
            if (res.data.success) { 
                alert(`Status successfully forced to ${newStatus}!`); 
                fetchApplications(); 
            }
        } catch (err) { 
            alert("Update failed."); 
        }
    };

    const filteredStudents = systemUsers.filter(u => 
        u.role === 'student' && 
        (u.name.toLowerCase().includes(studentSearch.toLowerCase()) || 
         u.email.toLowerCase().includes(studentSearch.toLowerCase()))
    );

    const filteredReviewers = systemUsers.filter(u => 
        u.role === 'reviewer' && 
        (u.name.toLowerCase().includes(reviewerSearch.toLowerCase()) || 
         u.email.toLowerCase().includes(reviewerSearch.toLowerCase()))
    );

    return (
        <div style={{ marginTop: '10px' }}>
            
            {/* 🎭 IMPERSONATION PANEL */}
            <div style={{ backgroundColor: '#f8f9fa', padding: '20px', borderRadius: '10px', textAlign: 'center', marginBottom: '30px', border: '2px dashed #004085' }}>
                <h2 style={{ marginTop: 0, color: '#004085' }}>🎭 Impersonate User</h2>
                <p style={{ fontSize: '14px', color: '#666', marginBottom: '20px' }}>Type a name or email to instantly filter and select a user.</p>
                
                <div style={{ display: 'flex', justifyContent: 'center', gap: '40px', flexWrap: 'wrap' }}>
                    
                    {/* 🆕 MODERN AUTOCOMPLETE: STUDENT */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', position: 'relative' }}>
                        <label style={{ fontWeight: 'bold', color: '#004085', marginBottom: '5px' }}>👨‍🎓 Impersonate Student</label>
                        
                        <input 
                            type="text" 
                            placeholder="🔍 Search or choose..." 
                            value={studentSearch}
                            onChange={(e) => setStudentSearch(e.target.value)}
                            onFocus={() => setShowStudentDropdown(true)}
                            // We use a tiny delay on blur so the user's click registers before the list vanishes!
                            onBlur={() => setTimeout(() => setShowStudentDropdown(false), 200)}
                            style={{ width: '250px', padding: '10px', border: '1px solid #004085', borderRadius: '5px', boxSizing: 'border-box', fontSize: '14px', outline: 'none' }}
                        />

                        {/* Floating Dropdown List */}
                        {showStudentDropdown && (
                            <div style={{ position: 'absolute', top: '70px', left: 0, width: '250px', maxHeight: '200px', overflowY: 'auto', backgroundColor: '#fff', border: '1px solid #004085', borderRadius: '5px', zIndex: 1000, boxShadow: '0 4px 8px rgba(0,0,0,0.1)' }}>
                                {filteredStudents.length === 0 ? (
                                    <div style={{ padding: '10px', color: '#dc3545', fontSize: '13px', textAlign: 'center' }}>No students found.</div>
                                ) : (
                                    filteredStudents.map(user => (
                                        <div 
                                            key={user.id}
                                            onClick={() => handleImpersonateSpecificUser(user)}
                                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f0f8ff'}
                                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#fff'}
                                            style={{ padding: '10px', cursor: 'pointer', borderBottom: '1px solid #eee', textAlign: 'left', transition: 'background-color 0.2s' }}
                                        >
                                            <div style={{ fontWeight: 'bold', color: '#004085', fontSize: '14px' }}>{user.name}</div>
                                            <div style={{ color: '#666', fontSize: '11px' }}>{user.email}</div>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}
                    </div>

                    {/* 🆕 MODERN AUTOCOMPLETE: REVIEWER */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', position: 'relative' }}>
                        <label style={{ fontWeight: 'bold', color: '#155724', marginBottom: '5px' }}>👨‍🏫 Impersonate Reviewer</label>
                        
                        <input 
                            type="text" 
                            placeholder="🔍 Search or choose..." 
                            value={reviewerSearch}
                            onChange={(e) => setReviewerSearch(e.target.value)}
                            onFocus={() => setShowReviewerDropdown(true)}
                            onBlur={() => setTimeout(() => setShowReviewerDropdown(false), 200)}
                            style={{ width: '250px', padding: '10px', border: '1px solid #28a745', borderRadius: '5px', boxSizing: 'border-box', fontSize: '14px', outline: 'none' }}
                        />

                        {/* Floating Dropdown List */}
                        {showReviewerDropdown && (
                            <div style={{ position: 'absolute', top: '70px', left: 0, width: '250px', maxHeight: '200px', overflowY: 'auto', backgroundColor: '#fff', border: '1px solid #28a745', borderRadius: '5px', zIndex: 1000, boxShadow: '0 4px 8px rgba(0,0,0,0.1)' }}>
                                {filteredReviewers.length === 0 ? (
                                    <div style={{ padding: '10px', color: '#dc3545', fontSize: '13px', textAlign: 'center' }}>No reviewers found.</div>
                                ) : (
                                    filteredReviewers.map(user => (
                                        <div 
                                            key={user.id}
                                            onClick={() => handleImpersonateSpecificUser(user)}
                                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#e2f0d9'}
                                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#fff'}
                                            style={{ padding: '10px', cursor: 'pointer', borderBottom: '1px solid #eee', textAlign: 'left', transition: 'background-color 0.2s' }}
                                        >
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

            {/* 🛡️ MASTER OVERRIDE TABLE */}
            <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '10px', border: '1px solid #003d7c' }}>
                <h2 style={{ marginTop: 0, color: '#003d7c' }}>🛡️ Admin Application Overrides</h2>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={{ backgroundColor: '#003d7c', color: 'white' }}>
                            <th style={{ padding: '12px', textAlign: 'left' }}>Student</th>
                            <th style={{ padding: '12px', textAlign: 'left' }}>Mapped Package</th>
                            <th style={{ padding: '12px', textAlign: 'center' }}>Status</th>
                            <th style={{ padding: '12px', textAlign: 'center' }}>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        {applications.length === 0 ? (
                            <tr><td colSpan="4" style={{ textAlign: 'center', padding: '20px' }}>No applications in system yet.</td></tr>
                        ) : applications.map(app => (
                            <tr key={app.id} style={{ borderBottom: '1px solid #eee' }}>
                                <td style={{ padding: '12px', fontWeight: 'bold' }}>{app.student_name}</td>
                                <td style={{ padding: '12px', color: '#555', fontSize: '13px' }}>
                                    {app.pte_course_names && app.pte_course_names.length > 50 
                                        ? app.pte_course_names.substring(0, 50) + '...' 
                                        : app.pte_course_names}
                                </td>
                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                    <span style={{ 
                                        fontWeight: 'bold', 
                                        padding: '4px 8px', 
                                        borderRadius: '4px',
                                        backgroundColor: app.status === 'approved' ? '#d4edda' : app.status === 'rejected' ? '#f8d7da' : '#fff3cd',
                                        color: app.status === 'approved' ? '#155724' : app.status === 'rejected' ? '#721c24' : '#856404' 
                                    }}>
                                        {app.status.toUpperCase()}
                                    </span>
                                </td>
                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                    <button onClick={() => handleUpdateStatus(app.id, 'pending')} style={{ cursor: 'pointer', padding: '6px 12px', backgroundColor: '#ffc107', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>🔄 Reset</button>
                                    <button onClick={() => handleUpdateStatus(app.id, 'approved')} style={{ cursor: 'pointer', marginLeft: '8px', padding: '6px 12px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>🚀 Force Approve</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default SuperAdminDashboard;