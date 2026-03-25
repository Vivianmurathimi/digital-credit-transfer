import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';

const Register = () => {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const navigate = useNavigate();

    const handleRegister = async (e) => {
        e.preventDefault();
        try {
            // We no longer send the role! The backend figures it out securely.
            const res = await axios.post('/api/register', { name, email, password });
            if (res.data.success) {
                alert("Registration successful! You can now log in.");
                navigate('/login');
            }
        } catch (err) {
            setError(err.response?.data?.error || 'Registration failed. Try a different email.');
        }
    };

    return (
        <div style={{ maxWidth: '400px', margin: '50px auto', padding: '20px', border: '1px solid #ccc', borderRadius: '8px', backgroundColor: '#f8f9fa' }}>
            <h2 style={{ textAlign: 'center', color: '#28a745', marginTop: 0 }}>Create University Account</h2>
            
            <div style={{ backgroundColor: '#e2e3f0', padding: '10px', borderRadius: '5px', marginBottom: '15px', fontSize: '13px', color: '#004085', border: '1px solid #b8daff' }}>
                <strong>🎓  Notice:</strong> use your email domain:
                <ul style={{ margin: '5px 0 0 0', paddingLeft: '20px' }}>
                    <li><code>@tr.pte.hu</code> (Students)</li>
                    <li><code>@mik.pte.hu</code> (staff)</li>
                </ul>
            </div>

            {error && <div style={{ backgroundColor: '#f8d7da', color: '#721c24', padding: '10px', borderRadius: '5px', marginBottom: '15px', fontWeight: 'bold', textAlign: 'center', border: '1px solid #f5c6cb' }}>{error}</div>}
            
            <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                <div>
                    <label style={{ fontWeight: 'bold' }}>Full Name</label>
                    <input type="text" value={name} onChange={(e) => setName(e.target.value)} required style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid #ccc', borderRadius: '4px' }} placeholder="John Doe" />
                </div>
                <div>
                    <label style={{ fontWeight: 'bold' }}>University Email</label>
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid #ccc', borderRadius: '4px' }} placeholder="johndoe@student.university.edu" />
                </div>
                <div>
                    <label style={{ fontWeight: 'bold' }}>Password</label>
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ width: '100%', padding: '10px', boxSizing: 'border-box', marginTop: '5px', border: '1px solid #ccc', borderRadius: '4px' }} placeholder="••••••••" />
                </div>
                
                <button type="submit" style={{ padding: '12px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '16px', marginTop: '10px' }}>
                     Registration
                </button>
            </form>
            
            <p style={{ textAlign: 'center', marginTop: '20px', fontSize: '14px' }}>
                Already have an account? <a href="/login" style={{ color: '#004085', fontWeight: 'bold', textDecoration: 'none' }}>Log in here</a>
            </p>
        </div>
    );
};

export default Register;