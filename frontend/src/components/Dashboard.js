import React from 'react';
import { useNavigate } from 'react-router-dom';

// Import our new sub-components!
import StudentDashboard from './StudentDashboard';
import ReviewerDashboard from './ReviewerDashboard';
import SuperAdminDashboard from './SuperAdminDashboard';

const Dashboard = () => {
    const navigate = useNavigate();
    
    // Universal Authentication & Role Logic
    const token = localStorage.getItem('token');
    if (!token) {
        navigate('/login');
        return null;
    }

    const realUserId = JSON.parse(atob(token.split('.')[1])).id;
    const originalRole = localStorage.getItem('originalRole');
    
    const userId = localStorage.getItem('impersonatedUserId') || realUserId;
    const role = localStorage.getItem('impersonatedRole') || localStorage.getItem('role');
    const impersonatedName = localStorage.getItem('impersonatedName');

    const handleLogout = () => { 
        localStorage.clear(); 
        navigate('/login'); 
    };

    const stopImpersonation = () => {
        localStorage.removeItem('originalRole');
        localStorage.removeItem('impersonatedRole');
        localStorage.removeItem('impersonatedUserId');
        localStorage.removeItem('impersonatedName');
        window.location.reload();
    };

    return (
        <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto', fontFamily: 'sans-serif' }}>
            
            {/* ⚠️ UNIVERSAL GOD MODE BANNER */}
            {originalRole && (
                <div style={{ backgroundColor: '#ffc107', padding: '15px', textAlign: 'center', fontWeight: 'bold', marginBottom: '20px', borderRadius: '8px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '20px' }}>
                    <span>⚠️ You are actively impersonating <strong>{impersonatedName}</strong> ({role.toUpperCase()})</span>
                    <button onClick={stopImpersonation} style={{ cursor: 'pointer', padding: '8px 15px', fontWeight: 'bold', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '4px' }}>End Impersonation</button>
                </div>
            )}

            {/* UNIVERSAL HEADER */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #ddd', paddingBottom: '10px', marginBottom: '30px' }}>
                <h1 style={{ color: '#003d7c', margin: 0 }}>University Portal</h1>
                <button onClick={handleLogout} style={{ padding: '10px 15px', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>Log Out</button>
            </div>

            {/* 🚦 THE TRAFFIC COP: Route to the correct dashboard based on role */}
            {role === 'superadmin' && !originalRole && <SuperAdminDashboard userId={userId} />}
            {role === 'reviewer' && <ReviewerDashboard />}
            {role === 'student' && <StudentDashboard userId={userId} />}

        </div>
    );
};

export default Dashboard;