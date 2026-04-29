import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTranslation } from 'react-i18next';

const VerifyEmail = () => {
    const { t } = useTranslation();
    const { token } = useParams();
    const navigate = useNavigate();
    
    const [status, setStatus] = useState('loading');
    const [message, setMessage] = useState(t('verify_loading_message'));

    const hasAttempted = useRef(false);

    useEffect(() => {
        const verifyAccount = async () => {
            if (hasAttempted.current) return;
            hasAttempted.current = true;

            try {
                await axios.get(`/api/verify/${token}`);
                setStatus('success');
                setMessage(t('verify_success_message'));
            } catch (err) {
                setStatus('error');
                setMessage(err.response?.data || t('verify_error_message'));
            }
        };

        verifyAccount();
    }, [token, t]);

    return (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '80vh' }}>
            <div style={{ textAlign: 'center', padding: '40px', backgroundColor: '#fff', borderRadius: '10px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', maxWidth: '500px' }}>
                {status === 'loading' && (
                    <>
                        <h2 style={{ color: '#004085' }}>{t('verify_loading_title')}</h2>
                        <p>{message}</p>
                    </>
                )}

                {status === 'success' && (
                    <>
                        <h2 style={{ color: '#28a745' }}>{t('verify_success_title')}</h2>
                        <p style={{ color: '#555', marginBottom: '20px' }}>{message}</p>
                        <button 
                            onClick={() => navigate('/login')} 
                            style={{ padding: '10px 20px', backgroundColor: '#004085', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '16px' }}
                        >
                            {t('verify_back_to_login')}
                        </button>
                    </>
                )}

                {status === 'error' && (
                    <>
                        <h2 style={{ color: '#dc3545' }}>{t('verify_error_title')}</h2>
                        <p style={{ color: '#555', marginBottom: '20px' }}>{message}</p>
                        <button 
                            onClick={() => navigate('/register')} 
                            style={{ padding: '10px 20px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}
                        >
                            {t('verify_back_to_register')}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};

export default VerifyEmail;