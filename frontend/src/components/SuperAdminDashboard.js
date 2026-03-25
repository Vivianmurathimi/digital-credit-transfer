import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const SuperAdminDashboard = () => {
    const [systemUsers, setSystemUsers] = useState([]);
    const [applications, setApplications] = useState([]);

    // Fetch all non-admin users for the impersonation dropdowns
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

    // Fetch all applications for the override table
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

    // Impersonation Logic
    const handleImpersonateSpecificUser = (user) => {
        localStorage.setItem('originalRole', 'superadmin');
        localStorage.setItem('impersonatedRole', user.role);
        localStorage.setItem('impersonatedUserId', user.id);
        localStorage.setItem('impersonatedName', user.name);
        window.location.reload();
    };

    // Master Override Logic
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

    return (
        <div style={{ marginTop: '10px' }}>
            
            {/* 🎭 IMPERSONATION PANEL */}
            <div style={{ backgroundColor: '#f8f9fa', padding: '20px', borderRadius: '10px', textAlign: 'center', marginBottom: '30px', border: '2px dashed #004085' }}>
                <h2 style={{ marginTop: 0, color: '#004085' }}>🎭 Impersonate User</h2>
                <p style={{ fontSize: '14px', color: '#666', marginBottom: '20px' }}>Select a specific user from the dropdowns below to instantly log in as them.</p>
                
                <div style={{ display: 'flex', justifyContent: 'center', gap: '40px', flexWrap: 'wrap' }}>
                    {/* STUDENT DROPDOWN */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                        <label style={{ fontWeight: 'bold', color: '#004085', marginBottom: '5px' }}>👨‍🎓 Impersonate Student</label>
                        <select 
                            onChange={(e) => {
                                if (e.target.value) handleImpersonateSpecificUser(JSON.parse(e.target.value));
                            }}
                            style={{ padding: '10px', width: '250px', border: '1px solid #004085', borderRadius: '5px', cursor: 'pointer', fontSize: '14px' }}
                        >
                            <option value="">-- Choose a Student --</option>
                            {systemUsers.filter(u => u.role === 'student').map(user => (
                                <option key={user.id} value={JSON.stringify(user)}>
                                    {user.name} ({user.email})
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* REVIEWER DROPDOWN */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                        <label style={{ fontWeight: 'bold', color: '#155724', marginBottom: '5px' }}>👨‍🏫 Impersonate Reviewer</label>
                        <select 
                            onChange={(e) => {
                                if (e.target.value) handleImpersonateSpecificUser(JSON.parse(e.target.value));
                            }}
                            style={{ padding: '10px', width: '250px', border: '1px solid #28a745', borderRadius: '5px', cursor: 'pointer', fontSize: '14px' }}
                        >
                            <option value="">-- Choose a Reviewer --</option>
                            {systemUsers.filter(u => u.role === 'reviewer').map(user => (
                                <option key={user.id} value={JSON.stringify(user)}>
                                    {user.name} ({user.email})
                                </option>
                            ))}
                        </select>
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
                                
                                {/* Truncated preview of the package for the admin table */}
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