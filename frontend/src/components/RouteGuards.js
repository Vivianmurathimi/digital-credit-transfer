import React from 'react';
import { Navigate } from 'react-router-dom';
import { forgetImpersonation, forgetSession, getSessionState } from '../session';

// Both guards decide with the same getSessionState(), so they can never send
// a user back and forth between /login and /dashboard.

// Pages that need a logged-in user (the dashboard)
export const RequireAuth = ({ children }) => {
    const session = getSessionState();

    if (!session.valid) {
        // Clearing twice is harmless, so this is safe during render
        forgetSession();
        const target = session.reason ? `/login?reason=${session.reason}` : '/login';
        return <Navigate to={target} replace />;
    }

    // Impersonation keys that do not belong to a real superadmin are ignored and removed
    if (session.dropImpersonation) forgetImpersonation();

    return children;
};

// Login and register only: a logged-in user goes straight to the dashboard.
// (Forgot/reset password, verify and email links stay open to everyone.)
export const GuestOnly = ({ children }) =>
    getSessionState().valid ? <Navigate to="/dashboard" replace /> : children;
