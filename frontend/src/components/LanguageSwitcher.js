import React from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api';

const LanguageSwitcher = () => {
  const { i18n } = useTranslation();

  const changeLanguage = (lng) => {
    i18n.changeLanguage(lng);

    // Logged in? Save the choice so notification emails use this language.
    // Uses the real account from the token (not an impersonated one).
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
      const userId = JSON.parse(atob(token.split('.')[1])).id;
      api.put(`/api/users/${userId}/language`, { language: lng })
        .catch((err) => console.error('Could not save language preference', err));
    } catch {
      /* malformed token: skip saving */
    }
  };

  const buttonStyle = {
    background: 'none',
    border: 'none',
    fontSize: '16px',
    color: 'white',
    cursor: 'pointer',
    margin: '0 8px',
    padding: '2px 0',
    opacity: 0.7,
    transition: 'all 0.2s',
    fontFamily: 'inherit'
  };

  const activeStyle = {
    ...buttonStyle,
    fontWeight: 'bold',
    opacity: 1,
    borderBottom: '2px solid white' // Underlines the active language
  };

  const dividerStyle = {
    color: 'white',
    opacity: 0.5,
    margin: '0 2px'
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', padding: '10px' }}>
      <button 
        style={i18n.language?.startsWith('en') ? activeStyle : buttonStyle} 
        onClick={() => changeLanguage('en')}
      >
        EN
      </button>
      <span style={dividerStyle}>|</span>
      <button 
        style={i18n.language?.startsWith('hu') ? activeStyle : buttonStyle} 
        onClick={() => changeLanguage('hu')}
      >
        HU
      </button>
      <span style={dividerStyle}>|</span>
      <button 
        style={i18n.language?.startsWith('de') ? activeStyle : buttonStyle} 
        onClick={() => changeLanguage('de')}
      >
        DE
      </button>
    </div>
  );
};

export default LanguageSwitcher;