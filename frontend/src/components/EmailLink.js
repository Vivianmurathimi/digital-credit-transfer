import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTranslation } from 'react-i18next';

// Seconds before an expired link sends the user to the login page
const REDIRECT_SECONDS = 5;

// Opened from the link in a notification email.
// The link is valid for 10 minutes and never logs anyone in by itself.
const EmailLink = () => {
    const { t } = useTranslation();
    const { token } = useParams();
    const navigate = useNavigate();
    const [expired, setExpired] = useState(false);
    const hasChecked = useRef(false);

    useEffect(() => {
        if (hasChecked.current) return;
        hasChecked.current = true;

        const checkLink = async () => {
            try {
                const res = await axios.get(`/api/email-link/${token}`);

                // Valid link: straight to the dashboard if this student is already logged in, otherwise log in first
                const savedToken = localStorage.getItem('token');
                let loggedInId = null;
                try {
                    loggedInId = savedToken ? JSON.parse(atob(savedToken.split('.')[1])).id : null;
                } catch {
                    loggedInId = null;
                }
                navigate(loggedInId === res.data.studentId ? '/dashboard' : '/login', { replace: true });
            } catch {
                setExpired(true);
            }
        };

        checkLink();
    }, [token, navigate]);

    // Expired or invalid link: show the message, then go to the login page
    useEffect(() => {
        if (!expired) return undefined;
        const timer = setTimeout(() => navigate('/login', { replace: true }), REDIRECT_SECONDS * 1000);
        return () => clearTimeout(timer);
    }, [expired, navigate]);

    return (
        <div style={{ maxWidth: '400px', margin: '50px auto', padding: '20px', border: '1px solid var(--border-strong)', borderRadius: '8px', textAlign: 'center' }}>
            {!expired ? (
                <p>{t('email_link_checking')}</p>
            ) : (
                <>
                    <h2 style={{ color: 'var(--danger-accent)', marginTop: 0 }}>{t('email_link_expired_title')}</h2>
                    <p>{t('email_link_expired_message', { seconds: REDIRECT_SECONDS })}</p>
                    <button
                        onClick={() => navigate('/login', { replace: true })}
                        style={{ padding: '10px 20px', backgroundColor: 'var(--brand)', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '16px' }}
                    >
                        {t('email_link_go_to_login')}
                    </button>
                </>
            )}
        </div>
    );
};

export default EmailLink;
