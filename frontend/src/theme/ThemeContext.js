import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const STORAGE_KEY = 'theme';
const ThemeContext = createContext(null);

// Returns 'light' or 'dark' if the user picked one before, otherwise null
function readSavedTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    return null; // private mode / storage blocked
  }
}

// Returns the operating system's current theme
function systemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/**
 * Provides { theme, toggleTheme, setTheme } to the app.
 *
 * - First visit: follows the operating system setting (and keeps following it
 *   if the OS switches, e.g. automatic dark mode at sunset).
 * - Once the user clicks the toggle, their choice is saved and wins from then on.
 */
export function ThemeProvider({ children }) {
  const [userChoice, setUserChoice] = useState(readSavedTheme);
  const [osTheme, setOsTheme] = useState(systemTheme);

  const theme = userChoice || osTheme;

  // Apply to <html> so the CSS variables in theme.css switch over
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Track OS changes (only matters while the user hasn't picked a theme)
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e) => setOsTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Set a specific theme and remember it
  const setTheme = useCallback((next) => {
    setUserChoice(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore storage errors */
    }
  }, []);

  // Flip between light and dark
  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

// Use in any component: const { theme, toggleTheme } = useTheme();
export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}