import React from 'react';

import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import Register from './components/Register';
import VerifyEmail from './components/VerifyEmail';
import ForgotPassword from './components/ForgotPassword';
import ResetPassword from './components/ResetPassword';
import LanguageSwitcher from './components/LanguageSwitcher'; // 🆕 Import the flag UI

function App() {

const { t } = useTranslation(); // 🆕 Grab the translation function
return (
    <Router>
      <div className="App">
        {/* 🆕 Updated Header with Flags and Translated Title */}
        <header style={{ backgroundColor: '#003d7c', padding: '10px 20px', color: 'white' }}>
          <LanguageSwitcher />
          <h1 style={{ textAlign: 'center', marginTop: '0' }}>{t('app_title')}</h1>
        </header>
        
        <main>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/verify/:token" element={<VerifyEmail />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password/:token" element={<ResetPassword />} />
            <Route path="/" element={<Navigate to="/login" />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;