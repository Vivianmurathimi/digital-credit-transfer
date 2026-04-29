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
        <div style={{ maxWidth: '400px', margin: '50px auto', padding: '20px', border: '1px solid #ccc', borderRadius: '8px', backgroundColor: '#f8f9fa' }}>
            <h2 style={{ textAlign: 'center', color: '#004085', marginTop: 0 }}>{t('reset_title')}</h2>
            
            {message && <div style={{ backgroundColor: '#d4edda', color: '#155724', padding: '10px', borderRadius: '5px', marginBottom: '15px', border: '1px solid #c3e6cb', textAlign: 'center' }}>{message}</div>}
            {error && <div style={{ backgroundColor: '#f8d7da', color: '#721c24', padding: '10px', borderRadius: '5px', marginBottom: '15px', border: '1px solid #f5c6cb', textAlign: 'center' }}>{error}</div>}

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                <div>
                    <label style={{ fontWeight: 'bold' }}>{t('reset_new_password_label')}</label>
                    <input 
                        type="password" 
                        value={newPassword} 
                        onChange={(e) => setNewPassword(e.target.value)} 
                        required 
                        style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid #ccc', borderRadius: '4px' }} 
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
                        style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid #ccc', borderRadius: '4px' }} 
                        placeholder={t('reset_password_placeholder')} 
                    />
                </div>
                
                <button type="submit" style={{ padding: '12px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '16px' }}>
                    {t('reset_button')}
                </button>
            </form>
        </div>
    );
};

export default ResetPassword;