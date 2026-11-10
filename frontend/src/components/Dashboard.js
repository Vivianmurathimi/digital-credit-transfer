import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { clearSession, getSessionState } from '../session';
import { exitActing } from '../acting';
import { getErrorMessage } from '../errorMessage';

import ProfileHeader from './ProfileHeader';
import StudentDashboard from './StudentDashboard';
import ReviewerDashboard from './ReviewerDashboard';
import AdminLayout from './admin/AdminLayout';

// Where Exit returns the admin: the menu section they started acting from (this tab only)
const RETURN_KEY = 'actingReturnTo';
const readReturn = () => { try { return sessionStorage.getItem(RETURN_KEY); } catch { return null; } };
const saveReturn = (path) => { try { sessionStorage.setItem(RETURN_KEY, path); } catch { /* storage blocked: Overview */ } };

const Dashboard = () => {
    const { t } = useTranslation();
    const location = useLocation();
    const navigate = useNavigate();

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

    // The admin menu lives under /admin (admin round Group 5); everyone else, and the admin while
    // acting as someone, uses /dashboard. The server checks every request either way.
    const onAdminPath = location.pathname.startsWith('/admin');
    if (role === 'superadmin' && !acting && !onAdminPath) return <Navigate to="/admin" replace />;
    if ((role !== 'superadmin' || acting) && onAdminPath) return <Navigate to="/dashboard" replace />;

    // Acting started from a menu section: remember it for Exit, then show the person's screen
    const handleActingStarted = (fromPath) => {
        saveReturn(fromPath);
        refreshSession();
        navigate('/dashboard');
    };

    // Removes only the session (keeps e.g. the chosen language) and goes to the login page
    const handleLogout = () => clearSession();

    const handleExit = async () => {
        setExiting(true);
        setExitError('');
        try {
            await exitActing();
            refreshSession();
            // Back to the admin menu section the acting started from (admin round Group 5)
            const back = readReturn();
            navigate(back && back.startsWith('/admin') ? back : '/admin');
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
            {role === 'superadmin' && <AdminLayout key={`superadmin-${userId}`} onActingStarted={handleActingStarted} />}
            {role === 'reviewer' && <ReviewerDashboard key={`reviewer-${userId}`} />}
            {role === 'student' && <StudentDashboard key={`student-${userId}`} userId={userId} />}
        </div>
    );
};

export default Dashboard;