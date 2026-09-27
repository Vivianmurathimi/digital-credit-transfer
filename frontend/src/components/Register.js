import React, { useState } from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';

const Register = () => {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
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
        <div style={{ maxWidth: '400px', margin: '50px auto', padding: '20px', border: '1px solid var(--border-strong)', borderRadius: '8px', backgroundColor: 'var(--surface-2)' }}>
            {isRegistered ? (
                <div style={{ textAlign: 'center', padding: '30px', backgroundColor: 'var(--success-bg)', borderRadius: '8px', color: 'var(--success-text)', border: '1px solid var(--success-border)' }}>
                    <h2 style={{ marginTop: 0 }}>{t('register_success_title')}</h2>
                    <p style={{ marginBottom: 0 }}>{t('register_success_message')}</p>
                </div>
            ) : (
                <>
                    <h2 style={{ textAlign: 'center', color: 'var(--success-accent)', marginTop: 0 }}>{t('register_title')}</h2>
                    
                    

                    {error && <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', padding: '10px', borderRadius: '5px', marginBottom: '15px', fontWeight: 'bold', textAlign: 'center', border: '1px solid var(--danger-border)' }}>{error}</div>}
                    
                    <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                        <div>
                            <label style={{ fontWeight: 'bold' }}>{t('register_full_name')}</label>
                            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid var(--border-strong)', borderRadius: '4px' }} placeholder={t('register_full_name_placeholder')} />
                        </div>
                        <div>
                            <label style={{ fontWeight: 'bold' }}>{t('register_email')}</label>
                            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid var(--border-strong)', borderRadius: '4px' }} placeholder={t('register_email_placeholder')} />
                        </div>
                        <div>
                            <label style={{ fontWeight: 'bold' }}>{t('register_password')}</label>
                            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid var(--border-strong)', borderRadius: '4px' }} placeholder={t('register_password_placeholder')} />
                        </div>
                        
                        <button type="submit" style={{ padding: '12px', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '16px', marginTop: '10px' }}>
                             {t('register_button')}
                        </button>
                    </form>
                    
                    <p style={{ textAlign: 'center', marginTop: '20px', fontSize: '14px' }}>
                        {t('register_already_account')} <a href="/login" style={{ color: 'var(--link)', fontWeight: 'bold', textDecoration: 'none' }}>{t('register_login_link')}</a>
                    </p>
                </>
            )}
        </div>
    );
};

export default Register;