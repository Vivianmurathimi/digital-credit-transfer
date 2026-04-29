import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const Login = () => {
    const { t } = useTranslation();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const navigate = useNavigate();

    const handleLogin = async (e) => {
        e.preventDefault();
        try {
            const res = await axios.post('/api/login', { email, password });
            if (res.data.success) {
                localStorage.setItem('token', res.data.token);
                localStorage.setItem('role', res.data.role);
                navigate('/dashboard');
            }
        } catch (err) {
            setError(err.response?.data?.error || t('login_error_default'));
        }
    };

    return (
        <div style={{ maxWidth: '400px', margin: '50px auto', padding: '20px', border: '1px solid #ccc', borderRadius: '8px' }}>
            <h2 style={{ textAlign: 'center', color: '#003d7c' }}>{t('login_title')}</h2>
            {error && <p style={{ color: 'red', textAlign: 'center', fontWeight: 'bold' }}>{error}</p>}
            
            <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                <div>
                    <label style={{ fontWeight: 'bold' }}>{t('login_email_label')}</label>
                    <input 
                        type="email" 
                        value={email} 
                        onChange={(e) => setEmail(e.target.value)} 
                        required 
                        style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px' }} 
                        placeholder={t('login_email_placeholder')}
                    />
                </div>
                <div>
                    <label style={{ fontWeight: 'bold' }}>{t('login_password_label')}</label>
                    <input 
                        type="password" 
                        value={password} 
                        onChange={(e) => setPassword(e.target.value)} 
                        required 
                        style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px' }} 
                        placeholder={t('login_password_placeholder')}
                    />
                </div>
                <button type="submit" style={{ padding: '10px', backgroundColor: '#004085', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '16px' }}>
                    {t('login')}
                </button>
            </form>
            <p style={{ textAlign: 'center', marginTop: '15px' }}>
                {t('login_register_prompt')} <a href="/register" style={{ color: '#004085', fontWeight: 'bold' }}>{t('login_register_link')}</a>
            </p>
            <div style={{ textAlign: 'center', marginTop: '-10px', marginBottom: '10px' }}>
                <a href="/forgot-password" style={{ fontSize: '13px', color: '#004085', textDecoration: 'none' }}>{t('login_forgot_password')}</a>
            </div>
        </div>
    );
};

export default Login;