import React from 'react';
import { useNavigate } from 'react-router-dom';

const Dashboard = () => {
    const navigate = useNavigate();
    
    // We grab the role that we saved during login!
    const role = localStorage.getItem('role'); 

    const handleLogout = () => {
        localStorage.removeItem('token');
        localStorage.removeItem('role');
        navigate('/login');
    };

    return (
        <div style={{ padding: '20px', maxWidth: '800px', margin: '40px auto', fontFamily: 'Arial, sans-serif' }}>
            <h2>PTE Credit Transfer Dashboard</h2>
            <p>Welcome! You are officially logged in as a: <strong>{role ? role.toUpperCase() : 'GUEST'}</strong></p>

            {/* 🎓 STUDENT VIEW */}
            {role === 'student' && (
                <div style={{ backgroundColor: '#e6f7ff', padding: '20px', borderRadius: '8px', marginTop: '20px', border: '1px solid #91d5ff' }}>
                    <h3>🎓 Student Portal</h3>
                    <p>Upload your past university syllabi here to request PTE credits.</p>
                    <button style={{ padding: '10px', marginRight: '10px', cursor: 'pointer' }}>Upload Syllabus (PDF)</button>
                    <button style={{ padding: '10px', cursor: 'pointer' }}>View My Requests</button>
                </div>
            )}

            {/* 👨‍🏫 REVIEWER VIEW */}
            {role === 'reviewer' && (
                <div style={{ backgroundColor: '#f6ffed', padding: '20px', borderRadius: '8px', marginTop: '20px', border: '1px solid #b7eb8f' }}>
                    <h3>👨‍🏫 Professor / Reviewer Portal</h3>
                    <p>Review student requests and approve or reject credit equivalency.</p>
                    <button style={{ padding: '10px', marginRight: '10px', cursor: 'pointer' }}>Review Pending Syllabi</button>
                    <button style={{ padding: '10px', cursor: 'pointer' }}>Credit History</button>
                </div>
            )}

            {/* 👑 SUPER ADMIN VIEW */}
            {role === 'superadmin' && (
                <div style={{ backgroundColor: '#fff0f6', padding: '20px', borderRadius: '8px', marginTop: '20px', border: '1px solid #ffadd2' }}>
                    <h3>👑 Super Admin Portal</h3>
                    <p>Complete system control. Manage users, oversee audits, and override decisions.</p>
                    <button style={{ padding: '10px', marginRight: '10px', cursor: 'pointer' }}>Manage Users</button>
                    <button style={{ padding: '10px', marginRight: '10px', cursor: 'pointer' }}>System Audit Logs</button>
                    <button style={{ padding: '10px', cursor: 'pointer' }}>Override Decisions</button>
                </div>
            )}

            <button onClick={handleLogout} style={{ marginTop: '40px', padding: '10px 20px', backgroundColor: '#ff4d4f', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>
                Log Out
            </button>
        </div>
    );
};

export default Dashboard;