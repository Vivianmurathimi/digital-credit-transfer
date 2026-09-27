import React, { useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const ForgotPassword = () => {
    const { t } = useTranslation();
    const [email, setEmail] = useState('');
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setIsLoading(true);
        setMessage('');
        setError('');

        try {
            // Adjust the URL if your backend uses a different prefix!
            const res = await axios.post('/api/forgot-password', { email });
            setMessage(res.data.message || t('forgot_message_default'));
        } catch (err) {
            setError(err.response?.data?.error || t('forgot_error_default'));
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div style={{ maxWidth: '400px', margin: '50px auto', padding: '20px', border: '1px solid var(--border-strong)', borderRadius: '8px', backgroundColor: 'var(--surface-2)' }}>
            <h2 style={{ textAlign: 'center', color: 'var(--link)', marginTop: 0 }}>{t('forgot_title')}</h2>
            
            {message && <div style={{ backgroundColor: 'var(--success-bg)', color: 'var(--success-text)', padding: '10px', borderRadius: '5px', marginBottom: '15px', border: '1px solid var(--success-border)', textAlign: 'center' }}>{message}</div>}
            {error && <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', padding: '10px', borderRadius: '5px', marginBottom: '15px', border: '1px solid var(--danger-border)', textAlign: 'center' }}>{error}</div>}

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                <div>
                    <label style={{ fontWeight: 'bold' }}>{t('forgot_email_label')}</label>
                    <input 
                        type="email" 
                        value={email} 
                        onChange={(e) => setEmail(e.target.value)} 
                        required 
                        style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid var(--border-strong)', borderRadius: '4px' }} 
                        placeholder={t('forgot_email_placeholder')} 
                    />
                </div>
                
                <button type="submit" disabled={isLoading} style={{ padding: '12px', backgroundColor: 'var(--brand)', color: 'white', border: 'none', borderRadius: '5px', cursor: isLoading ? 'not-allowed' : 'pointer', fontWeight: 'bold', fontSize: '16px' }}>
                    {isLoading ? t('forgot_sending') : t('forgot_send_button')}
                </button>
            </form>

            <p style={{ textAlign: 'center', marginTop: '20px', fontSize: '14px' }}>
                {t('forgot_remember_password')} <Link to="/login" style={{ color: 'var(--link)', fontWeight: 'bold', textDecoration: 'none' }}>{t('forgot_login_link')}</Link>
            </p>
        </div>
    );
};

export default ForgotPassword;