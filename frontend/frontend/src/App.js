import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Login from './components/Login';

function App() {
  return (
    <Router>
      <div className="App">
        {/* This is the PTE Blue Header */}
        <header style={{ backgroundColor: '#003d7c', padding: '20px', color: 'white', textAlign: 'center' }}>
          <h1>PTE Digital Credit Transfer</h1>
        </header>

        <main>
          <Routes>
            {/* When the user goes to /login, show the Login component */}
            <Route path="/login" element={<Login />} />
            
            {/* If they just go to http://localhost:3000, send them to /login */}
            <Route path="/" element={<Navigate to="/login" />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;