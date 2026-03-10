import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate, Link } from 'react-router-dom';

const Register = () => {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [message, setMessage] = useState('');
    const navigate = useNavigate();

    const handleRegister = async (e) => {
        e.preventDefault();
        try {
            const response = await axios.post('/api/register', { name, email, password });
            setMessage(response.data.message);
            
            // Send them to the login page after 2 seconds
            setTimeout(() => {
                navigate('/login');
            }, 2000);
        } catch (error) {
            setMessage('❌ Registration Failed: ' + (error.response?.data?.error || 'Server error'));
        }
    };

    return (
        <div style={{ maxWidth: '400px', margin: '80px auto', padding: '20px', border: '1px solid #ddd', borderRadius: '10px', textAlign: 'center', backgroundColor: '#fff', boxShadow: '0 4px 8px rgba(0,0,0,0.1)' }}>
            <h2 style={{ color: '#003d7c' }}>Student Registration</h2>
            <p>Create an account to transfer your credits.</p>
            
            <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginTop: '20px' }}>
                <input type="text" placeholder="Full Name (e.g. John Doe)" value={name} onChange={(e) => setName(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />
                <input type="email" placeholder="University Email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />
                <input type="password" placeholder="Create a Password" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />
                
                <button type="submit" style={{ padding: '12px', backgroundColor: '#28a745', color: 'white', border: 'none', cursor: 'pointer', borderRadius: '5px', fontWeight: 'bold' }}>
                    Register Account
                </button>
            </form>
            
            {message && <p style={{ marginTop: '20px', fontWeight: 'bold' }}>{message}</p>}
            
            <div style={{ marginTop: '20px' }}>
                <p>Already have an account? <Link to="/login" style={{ color: '#003d7c', fontWeight: 'bold' }}>Log in here</Link></p>
            </div>
        </div>
    );
};

export default Register;