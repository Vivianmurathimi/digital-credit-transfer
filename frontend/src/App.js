import React, { useEffect } from 'react';

import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import Register from './components/Register';
import VerifyEmail from './components/VerifyEmail';
import ForgotPassword from './components/ForgotPassword';
import ResetPassword from './components/ResetPassword';
import LanguageSwitcher from './components/LanguageSwitcher'; // 🆕 Import the flag UI
import EmailLink from './components/EmailLink';
import Notice from './components/Notice';
import { startSessionKeeper, stopSessionKeeper } from './sessionKeeper';

function App() {

const { t } = useTranslation(); // 🆕 Grab the translation function

// Renews the token while the user is active; logs out after 30 minutes of inactivity
useEffect(() => {
    startSessionKeeper();
    return stopSessionKeeper;
}, []);
return (
    <Router>
      <div className="App">
        {/* 🆕 Updated Header with Flags and Translated Title */}
        <header style={{ backgroundColor: 'var(--header-bg)', padding: '10px 20px', color: 'white' }}>
          <LanguageSwitcher />
          <h1 style={{ textAlign: 'center', marginTop: '0' }}>{t('app_title')}</h1>
        </header>
        
        <Notice />

        <main>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/verify/:token" element={<VerifyEmail />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password/:token" element={<ResetPassword />} />
            <Route path="/email-link/:token" element={<EmailLink />} />
            <Route path="/" element={<Navigate to="/login" />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;