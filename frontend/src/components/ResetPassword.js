import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTranslation } from 'react-i18next';

const ResetPassword = () => {
    const { t } = useTranslation();
    const { token } = useParams();
    const navigate = useNavigate();
    
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setMessage('');
        setError('');

        if (newPassword !== confirmPassword) {
            return setError(t('reset_error_password_mismatch'));
        }

        try {
            const res = await axios.post(`/api/reset-password/${token}`, { newPassword });
            setMessage(res.data.message || t('reset_success_message'));
            setTimeout(() => navigate('/login'), 2000);
        } catch (err) {
            setError(err.response?.data?.error || t('reset_error_default'));
        }
    };

    return (
        <div style={{ maxWidth: '400px', margin: '50px auto', padding: '20px', border: '1px solid var(--border-strong)', borderRadius: '8px', backgroundColor: 'var(--surface-2)' }}>
            <h2 style={{ textAlign: 'center', color: 'var(--link)', marginTop: 0 }}>{t('reset_title')}</h2>
            
            {message && <div style={{ backgroundColor: 'var(--success-bg)', color: 'var(--success-text)', padding: '10px', borderRadius: '5px', marginBottom: '15px', border: '1px solid var(--success-border)', textAlign: 'center' }}>{message}</div>}
            {error && <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', padding: '10px', borderRadius: '5px', marginBottom: '15px', border: '1px solid var(--danger-border)', textAlign: 'center' }}>{error}</div>}

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                <div>
                    <label style={{ fontWeight: 'bold' }}>{t('reset_new_password_label')}</label>
                    <input 
                        type="password" 
                        value={newPassword} 
                        onChange={(e) => setNewPassword(e.target.value)} 
                        required 
                        style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid var(--border-strong)', borderRadius: '4px' }} 
                        placeholder={t('reset_password_placeholder')} 
                    />
                </div>
                <div>
                    <label style={{ fontWeight: 'bold' }}>{t('reset_confirm_password_label')}</label>
                    <input 
                        type="password" 
                        value={confirmPassword} 
                        onChange={(e) => setConfirmPassword(e.target.value)} 
                        required 
                        style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid var(--border-strong)', borderRadius: '4px' }} 
                        placeholder={t('reset_password_placeholder')} 
                    />
                </div>
                
                <button type="submit" style={{ padding: '12px', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '16px' }}>
                    {t('reset_button')}
                </button>
            </form>
        </div>
    );
};

export default ResetPassword;