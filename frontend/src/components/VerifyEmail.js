import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';

const VerifyEmail = () => {
    const { token } = useParams(); // Grabs the token from the URL
    const navigate = useNavigate();
    
    const [status, setStatus] = useState('loading'); // 'loading', 'success', or 'error'
    const [message, setMessage] = useState('Verifying your email...');

    const hasAttempted = useRef(false);

    useEffect(() => {
        const verifyAccount = async () => {

        if (hasAttempted.current) return;
            hasAttempted.current = true;

            try {
                // Call your backend route to verify the token
                // Note: Adjust the URL if your auth routes are under '/api/auth' instead of just '/api'
                await axios.get(`/api/verify/${token}`);
                setStatus('success');
                setMessage('Email verified successfully! Your account is now active.');
            } catch (err) {
                setStatus('error');
                setMessage(err.response?.data || 'Verification failed. The link may be invalid or expired.');
            }
        };

        verifyAccount();
    }, [token]);

    return (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '80vh' }}>
            <div style={{ textAlign: 'center', padding: '40px', backgroundColor: '#fff', borderRadius: '10px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', maxWidth: '500px' }}>
                
                {status === 'loading' && (
                    <>
                        <h2 style={{ color: '#004085' }}>⏳ Verifying...</h2>
                        <p>{message}</p>
                    </>
                )}

                {status === 'success' && (
                    <>
                        <h2 style={{ color: '#28a745' }}>✅ Account Verified!</h2>
                        <p style={{ color: '#555', marginBottom: '20px' }}>{message}</p>
                        <button 
                            onClick={() => navigate('/login')} 
                            style={{ padding: '10px 20px', backgroundColor: '#004085', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '16px' }}
                        >
                            Proceed to Log In
                        </button>
                    </>
                )}

                {status === 'error' && (
                    <>
                        <h2 style={{ color: '#dc3545' }}>❌ Verification Error</h2>
                        <p style={{ color: '#555', marginBottom: '20px' }}>{message}</p>
                        <button 
                            onClick={() => navigate('/register')} 
                            style={{ padding: '10px 20px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}
                        >
                            Back to Registration
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};

export default VerifyEmail;