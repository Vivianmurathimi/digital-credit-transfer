// Shared inline styles of the admin screens (admin round Group 4), from the theme's colour tokens

// Section cards: a light tint and a thin border (admin round Group 8)
export const card = { backgroundColor: 'var(--section-bg)', padding: '20px', borderRadius: '10px', border: '1px solid var(--section-border)', boxShadow: '0 1px 2px var(--shadow-sm)', marginBottom: '30px' };
// Warning and notice boxes: kind = info | success | warning | danger
export const banner = (kind) => ({
    backgroundColor: `var(--banner-${kind}-bg)`, color: `var(--banner-${kind}-text)`, border: `1px solid var(--banner-${kind}-border)`,
    padding: '12px', borderRadius: '6px', marginBottom: '10px',
});
export const label = { display: 'block', fontWeight: 'bold', marginBottom: '4px' };
export const input = { width: '100%', padding: '8px', boxSizing: 'border-box', border: '1px solid var(--border-strong)', borderRadius: '4px', font: 'inherit' };
export const th = { padding: '8px', textAlign: 'left', borderBottom: '2px solid var(--border)', fontSize: '14px' };
export const td = { padding: '8px', borderBottom: '1px solid var(--border-subtle)', fontSize: '14px', verticalAlign: 'top', overflowWrap: 'anywhere' };
export const smallButton = (danger = false) => ({
    padding: '5px 10px', marginRight: '6px', marginBottom: '4px', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold', font: 'inherit',
    border: `1px solid ${danger ? 'var(--danger-border)' : 'var(--border-strong)'}`,
    backgroundColor: danger ? 'var(--danger-bg)' : 'var(--surface)', color: danger ? 'var(--danger-text)' : 'var(--text)',
});
export const disabledButton = { opacity: 0.5, cursor: 'not-allowed' };
