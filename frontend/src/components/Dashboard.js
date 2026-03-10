import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';

const Dashboard = () => {
    const navigate = useNavigate();
    const role = localStorage.getItem('role');
    const [users, setUsers] = useState([]);
    const [message, setMessage] = useState('');

    // If the user is a superadmin, fetch the user list when the dashboard loads
    useEffect(() => {
        if (role === 'superadmin') {
            fetchUsers();
        }
    }, [role]);

    const fetchUsers = async () => {
        try {
            const response = await axios.get('/api/users');
            setUsers(response.data);
        } catch (error) {
            console.error('Error fetching users', error);
        }
    };

    const handleRoleChange = async (userId, newRole) => {
        try {
            await axios.put(`/api/users/${userId}/role`, { role: newRole });
            setMessage(`✅ Role updated successfully!`);
            fetchUsers(); // Refresh the table to show the new role
            setTimeout(() => setMessage(''), 3000); // Clear message after 3 seconds
        } catch (error) {
            setMessage('❌ Failed to update role.');
        }
    };

    const handleLogout = () => {
        localStorage.removeItem('token');
        localStorage.removeItem('role');
        navigate('/login');
    };

    return (
        <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h1 style={{ color: '#003d7c' }}>Welcome to the Dashboard</h1>
                <button onClick={handleLogout} style={{ padding: '10px 15px', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>
                    Log Out
                </button>
            </div>

            <h3 style={{ color: '#555' }}>Your Role: <span style={{ textTransform: 'uppercase', color: '#003d7c' }}>{role}</span></h3>

            {/* --- SUPER ADMIN VIEW --- */}
            {role === 'superadmin' && (
                <div style={{ marginTop: '30px', backgroundColor: '#fdf3f4', padding: '20px', borderRadius: '10px', border: '1px solid #f5c6cb' }}>
                    <h2 style={{ color: '#721c24', marginTop: '0' }}>👑 Super Admin Control Panel</h2>
                    <p>Manage system users and assign roles below.</p>
                    
                    {message && <p style={{ fontWeight: 'bold', color: 'green' }}>{message}</p>}

                    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '15px', backgroundColor: '#fff' }}>
                        <thead>
                            <tr style={{ backgroundColor: '#003d7c', color: 'white', textAlign: 'left' }}>
                                <th style={{ padding: '10px', border: '1px solid #ddd' }}>ID</th>
                                <th style={{ padding: '10px', border: '1px solid #ddd' }}>Name</th>
                                <th style={{ padding: '10px', border: '1px solid #ddd' }}>Email</th>
                                <th style={{ padding: '10px', border: '1px solid #ddd' }}>Assign Role</th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.map((user) => (
                                <tr key={user.id}>
                                    <td style={{ padding: '10px', border: '1px solid #ddd' }}>{user.id}</td>
                                    <td style={{ padding: '10px', border: '1px solid #ddd' }}>{user.full_name}</td>
                                    <td style={{ padding: '10px', border: '1px solid #ddd' }}>{user.email}</td>
                                    <td style={{ padding: '10px', border: '1px solid #ddd' }}>
                                        <select 
                                            value={user.role} 
                                            onChange={(e) => handleRoleChange(user.id, e.target.value)}
                                            style={{ padding: '5px', borderRadius: '3px' }}
                                        >
                                            <option value="student">Student</option>
                                            <option value="reviewer">Reviewer</option>
                                            <option value="superadmin">Super Admin</option>
                                        </select>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* --- REVIEWER VIEW --- */}
            {role === 'reviewer' && (
                <div style={{ marginTop: '30px', backgroundColor: '#e2f0d9', padding: '20px', borderRadius: '10px', border: '1px solid #c3e6cb' }}>
                    <h2 style={{ color: '#155724', marginTop: '0' }}>👨‍🏫 Reviewer Portal</h2>
                    <p>Pending credit transfer requests will appear here soon.</p>
                </div>
            )}

            {/* --- STUDENT VIEW --- */}
            {role === 'student' && (
                <div style={{ marginTop: '30px', backgroundColor: '#e2e3f0', padding: '20px', borderRadius: '10px', border: '1px solid #b8daff' }}>
                    <h2 style={{ color: '#004085', marginTop: '0' }}>🎓 Student Portal</h2>
                    <p>You can upload your syllabus and apply for credit transfer here soon.</p>
                </div>
            )}
        </div>
    );
};

export default Dashboard;