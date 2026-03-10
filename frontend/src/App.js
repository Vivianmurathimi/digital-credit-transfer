import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Login from './components/Login';
import Dashboard from './components/Dashboard'; // <-- We import the real one now!
import Register from './components/Register';

function App() {
  return (
    <Router>
      <div className="App">
        <header style={{ backgroundColor: '#003d7c', padding: '20px', color: 'white', textAlign: 'center' }}>
          <h1>PTE Credit Transfer</h1>
        </header>
        
        <main>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/dashboard" element={<Dashboard />} /> 
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;