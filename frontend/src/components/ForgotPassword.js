import React, { useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';

const ForgotPassword = () => {
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
            setMessage(res.data.message);
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to send request. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div style={{ maxWidth: '400px', margin: '50px auto', padding: '20px', border: '1px solid #ccc', borderRadius: '8px', backgroundColor: '#f8f9fa' }}>
            <h2 style={{ textAlign: 'center', color: '#004085', marginTop: 0 }}>Reset Password</h2>
            
            {message && <div style={{ backgroundColor: '#d4edda', color: '#155724', padding: '10px', borderRadius: '5px', marginBottom: '15px', border: '1px solid #c3e6cb', textAlign: 'center' }}>{message}</div>}
            {error && <div style={{ backgroundColor: '#f8d7da', color: '#721c24', padding: '10px', borderRadius: '5px', marginBottom: '15px', border: '1px solid #f5c6cb', textAlign: 'center' }}>{error}</div>}

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                <div>
                    <label style={{ fontWeight: 'bold' }}>Enter your University Email</label>
                    <input 
                        type="email" 
                        value={email} 
                        onChange={(e) => setEmail(e.target.value)} 
                        required 
                        style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid #ccc', borderRadius: '4px' }} 
                        placeholder="johndoe@tr.pte.hu" 
                    />
                </div>
                
                <button type="submit" disabled={isLoading} style={{ padding: '12px', backgroundColor: '#004085', color: 'white', border: 'none', borderRadius: '5px', cursor: isLoading ? 'not-allowed' : 'pointer', fontWeight: 'bold', fontSize: '16px' }}>
                    {isLoading ? 'Sending...' : 'Send Reset Link'}
                </button>
            </form>

            <p style={{ textAlign: 'center', marginTop: '20px', fontSize: '14px' }}>
                Remember your password? <Link to="/login" style={{ color: '#004085', fontWeight: 'bold', textDecoration: 'none' }}>Log in</Link>
            </p>
        </div>
    );
};

export default ForgotPassword;