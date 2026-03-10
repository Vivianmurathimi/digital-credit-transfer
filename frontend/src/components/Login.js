import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate, Link } from 'react-router-dom';

const Login = () => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [message, setMessage] = useState('');
    const navigate = useNavigate();

    const handleLogin = async (e) => {
        e.preventDefault();
        try {
            const response = await axios.post('/api/login', { email, password });
            localStorage.setItem('token', response.data.token);
            localStorage.setItem('role', response.data.role);

            setMessage('✅ Login Successful! Redirecting...');
            setTimeout(() => {
                navigate('/dashboard');
            }, 1000);
        } catch (error) {
            setMessage('❌ Login Failed: ' + (error.response?.data?.error || 'Server error'));
        }
    };

    return (
        <div style={{ maxWidth: '400px', margin: '80px auto', border: '1px solid #ddd', borderRadius: '10px', textAlign: 'center', backgroundColor: '#fff', overflow: 'hidden', boxShadow: '0 4px 8px rgba(0,0,0,0.1)' }}>


            <div style={{ padding: '20px' }}>
                <h2 style={{ marginTop: '0', color: '#003d7c' }}>Portal Login</h2>
                <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginTop: '20px' }}>
                    <input type="email" placeholder="Email (e.g. admin@example.com)" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />
                    <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />
                    <button type="submit" style={{ padding: '12px', backgroundColor: '#003d7c', color: 'white', border: 'none', cursor: 'pointer', borderRadius: '5px', fontWeight: 'bold', fontSize: '16px' }}>
                        Log In
                    </button>
                </form>
                {message && <p style={{ marginTop: '20px', fontWeight: 'bold' }}>{message}</p>}
                
                <div style={{ marginTop: '15px' }}>
                    <p>New student? <Link to="/register" style={{ color: '#003d7c', fontWeight: 'bold' }}>Register here</Link></p>
                </div>
            </div>
        </div>
    );
};

export default Login;