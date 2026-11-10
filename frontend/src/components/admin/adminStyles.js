// Shared inline styles of the admin screens (admin round Group 4), from the theme's colour tokens

export const card = { backgroundColor: 'var(--surface)', padding: '20px', borderRadius: '10px', border: '2px solid var(--border)', marginBottom: '30px' };
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
