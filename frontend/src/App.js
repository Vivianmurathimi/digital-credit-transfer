import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
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
            
            {/* THIS is the line that uses Navigate! It fixes the blank screen. */}
            <Route path="/" element={<Navigate to="/login" />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;