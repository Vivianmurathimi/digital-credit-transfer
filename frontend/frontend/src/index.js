import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App'; // This tells React to load your App.js

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);