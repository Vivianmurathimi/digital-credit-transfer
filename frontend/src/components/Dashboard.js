import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clearSession, getSessionState } from '../session';
import { exitActing } from '../acting';
import { getErrorMessage } from '../errorMessage';

import ProfileHeader from './ProfileHeader';
import StudentDashboard from './StudentDashboard';
import ReviewerDashboard from './ReviewerDashboard';
import SuperAdminDashboard from './SuperAdminDashboard';

const Dashboard = () => {
    const { t } = useTranslation();

    // RequireAuth has already checked the session; `view` is whose dashboard to show. While the
    // admin acts as a student or reviewer (admin round Group 1), the session itself is that
    // person's, so their dashboard works exactly as for them. Starting and exiting swap the
    // session token, and this state shows the matching dashboard without reloading the page.
    const [session, setSession] = useState(getSessionState);
    const refreshSession = useCallback(() => setSession(getSessionState()), []);
    const [exitError, setExitError] = useState('');
    const [exiting, setExiting] = useState(false);

    if (!session.valid) return null;
    const { userId, role, name: actingName, acting } = session.view;

    // Removes only the session (keeps e.g. the chosen language) and goes to the login page
    const handleLogout = () => clearSession();

    const handleExit = async () => {
        setExiting(true);
        setExitError('');
        try {
            await exitActing();
            refreshSession();
        } catch (err) {
            setExitError(getErrorMessage(err, t, 'acting_exit_failed'));
        } finally {
            setExiting(false);
        }
    };

    return (
        <div style={{ padding: '20px', margin: '0 auto', fontFamily: 'sans-serif' }}>
            {acting && (
                <div role="status" style={{ backgroundColor: 'var(--yellow)', color: '#000', padding: '15px', textAlign: 'center', fontWeight: 'bold', marginBottom: '20px', borderRadius: '8px', display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: '20px' }}>
                    <span>{t('acting_banner', { name: actingName, role: t(`role_${role}`) })}</span>
                    <button type="button" onClick={handleExit} disabled={exiting} style={{ cursor: exiting ? 'wait' : 'pointer', padding: '8px 15px', fontWeight: 'bold', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '4px' }}>{t('acting_exit')}</button>
                    {exitError && <span role="alert" style={{ width: '100%' }}>{exitError}</span>}
                </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '15px', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid var(--border)', paddingBottom: '10px', marginBottom: '30px' }}>
                <h1 style={{ color: 'var(--heading)', margin: 0 }}>{t('dashboard_title')}</h1>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', alignItems: 'center', justifyContent: 'flex-end' }}>
                    {/* The profile of the person the session is for (while acting: that person's) */}
                    <ProfileHeader key={`${role}-${userId}`} />
                    <button onClick={handleLogout} style={{ padding: '10px 15px', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>{t('logout_button')}</button>
                </div>
            </div>

            {/* keyed by person, so nothing from the previous session's screen is kept */}
            {role === 'superadmin' && <SuperAdminDashboard key={`superadmin-${userId}`} onActingStarted={refreshSession} />}
            {role === 'reviewer' && <ReviewerDashboard key={`reviewer-${userId}`} />}
            {role === 'student' && <StudentDashboard key={`student-${userId}`} userId={userId} />}
        </div>
    );
};

export default Dashboard;