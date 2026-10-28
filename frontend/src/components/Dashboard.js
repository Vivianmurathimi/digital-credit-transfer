import React from 'react';
import { useTranslation } from 'react-i18next';
import { clearSession, forgetImpersonation, getSessionState } from '../session';

import ProfileHeader from './ProfileHeader';
import StudentDashboard from './StudentDashboard';
import ReviewerDashboard from './ReviewerDashboard';
import SuperAdminDashboard from './SuperAdminDashboard';

const Dashboard = () => {
    const { t } = useTranslation();

    // RequireAuth has already checked the session; `view` is whose dashboard to show
    // (the role comes from the token, impersonation only for a real superadmin)
    const session = getSessionState();
    if (!session.valid) return null;
    const { userId, role, name: impersonatedName, impersonating } = session.view;

    // Removes only the session (keeps e.g. the chosen language) and goes to the login page
    const handleLogout = () => clearSession();

    const stopImpersonation = () => {
        forgetImpersonation();
        window.location.reload();
    };

    return (
        <div style={{ padding: '20px', margin: '0 auto', fontFamily: 'sans-serif' }}>
            {impersonating && (
                <div style={{ backgroundColor: 'var(--yellow)', color: '#000', padding: '15px', textAlign: 'center', fontWeight: 'bold', marginBottom: '20px', borderRadius: '8px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '20px' }}>
                    <span>{t('impersonation_banner', { name: impersonatedName, role: t(`role_${role}`) })}</span>
                    <button onClick={stopImpersonation} style={{ cursor: 'pointer', padding: '8px 15px', fontWeight: 'bold', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '4px' }}>{t('end_impersonation')}</button>
                </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '15px', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid var(--border)', paddingBottom: '10px', marginBottom: '30px' }}>
                <h1 style={{ color: 'var(--heading)', margin: 0 }}>{t('dashboard_title')}</h1>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', alignItems: 'center', justifyContent: 'flex-end' }}>
                    {/* The logged-in person's own profile; not while the superadmin impersonates someone */}
                    {!impersonating && <ProfileHeader />}
                    <button onClick={handleLogout} style={{ padding: '10px 15px', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>{t('logout_button')}</button>
                </div>
            </div>

            {role === 'superadmin' && !impersonating && <SuperAdminDashboard userId={userId} />}
            {role === 'reviewer' && <ReviewerDashboard />}
            {role === 'student' && <StudentDashboard userId={userId} isImpersonating={impersonating} />}
        </div>
    );
};

export default Dashboard;