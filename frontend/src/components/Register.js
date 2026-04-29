import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const Register = () => {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const navigate = useNavigate();
    const [isRegistered, setIsRegistered] = useState(false);

    const handleRegister = async (e) => {
        e.preventDefault();
        try {
            const res = await axios.post('/api/register', { name, email, password });
            if (res.data.success) {
                setIsRegistered(true);
            }
        } catch (err) {
            setError(err.response?.data?.error || t('register_error_default'));
        }
    };

    return (
        <div style={{ maxWidth: '400px', margin: '50px auto', padding: '20px', border: '1px solid #ccc', borderRadius: '8px', backgroundColor: '#f8f9fa' }}>
            {isRegistered ? (
                <div style={{ textAlign: 'center', padding: '30px', backgroundColor: '#d4edda', borderRadius: '8px', color: '#155724', border: '1px solid #c3e6cb' }}>
                    <h2 style={{ marginTop: 0 }}>{t('register_success_title')}</h2>
                    <p style={{ marginBottom: 0 }}>{t('register_success_message')}</p>
                </div>
            ) : (
                <>
                    <h2 style={{ textAlign: 'center', color: '#28a745', marginTop: 0 }}>{t('register_title')}</h2>
                    
                    <div style={{ backgroundColor: '#e2e3f0', padding: '10px', borderRadius: '5px', marginBottom: '15px', fontSize: '13px', color: '#004085', border: '1px solid #b8daff' }}>
                        <strong>{t('register_notice_label')}</strong> {t('register_notice_text')}
                        <ul style={{ margin: '5px 0 0 0', paddingLeft: '20px' }}>
                            <li><code>@tr.pte.hu</code> ({t('register_notice_students')})</li>
                            <li><code>@mik.pte.hu</code> ({t('register_notice_staff')})</li>
                        </ul>
                    </div>

                    {error && <div style={{ backgroundColor: '#f8d7da', color: '#721c24', padding: '10px', borderRadius: '5px', marginBottom: '15px', fontWeight: 'bold', textAlign: 'center', border: '1px solid #f5c6cb' }}>{error}</div>}
                    
                    <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                        <div>
                            <label style={{ fontWeight: 'bold' }}>{t('register_full_name')}</label>
                            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid #ccc', borderRadius: '4px' }} placeholder={t('register_full_name_placeholder')} />
                        </div>
                        <div>
                            <label style={{ fontWeight: 'bold' }}>{t('register_email')}</label>
                            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid #ccc', borderRadius: '4px' }} placeholder={t('register_email_placeholder')} />
                        </div>
                        <div>
                            <label style={{ fontWeight: 'bold' }}>{t('register_password')}</label>
                            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid #ccc', borderRadius: '4px' }} placeholder={t('register_password_placeholder')} />
                        </div>
                        
                        <button type="submit" style={{ padding: '12px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '16px', marginTop: '10px' }}>
                             {t('register_button')}
                        </button>
                    </form>
                    
                    <p style={{ textAlign: 'center', marginTop: '20px', fontSize: '14px' }}>
                        {t('register_already_account')} <a href="/login" style={{ color: '#004085', fontWeight: 'bold', textDecoration: 'none' }}>{t('register_login_link')}</a>
                    </p>
                </>
            )}
        </div>
    );
};

export default Register;