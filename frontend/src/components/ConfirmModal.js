import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

// An in-app confirmation (fixes 1a), instead of the browser's window.confirm: translated, styled
// like the other dialogs, focus moves into it, Escape and Cancel close it.
// title / text: what is asked; confirmLabel: the confirm button (default "Confirm");
// danger: a red confirm button for something that can't be undone; busy: while it runs.
const ConfirmModal = ({ title, text, confirmLabel, danger = false, busy = false, onConfirm, onCancel }) => {
    const { t } = useTranslation();
    const dialogRef = useRef(null);
    useEffect(() => { dialogRef.current?.focus(); }, []);
    const button = (primary) => ({
        padding: '8px 15px', cursor: busy ? 'default' : 'pointer', borderRadius: '4px', fontWeight: 'bold',
        ...(primary
            ? { backgroundColor: danger ? 'var(--cue-btn-reject)' : 'var(--brand)', color: danger ? 'var(--cue-btn-reject-text)' : 'var(--text-on-primary)', border: 'none' }
            : { border: '1px solid var(--border-strong)', backgroundColor: 'var(--surface)', color: 'var(--text)' }),
    });

    return (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'var(--overlay)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '16px' }}>
            <div
                ref={dialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-text"
                onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onCancel(); }}
                style={{ backgroundColor: 'var(--surface)', color: 'var(--text)', padding: '25px', borderRadius: '10px', width: '460px', maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 5px 15px var(--shadow-modal)', outline: 'none' }}
            >
                <h3 id="confirm-title" style={{ marginTop: 0, color: 'var(--link)' }}>{title}</h3>
                <p id="confirm-text" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</p>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                    <button type="button" disabled={busy} onClick={onCancel} style={button(false)}>{t('confirm_cancel')}</button>
                    <button type="button" disabled={busy} onClick={onConfirm} style={button(true)}>{confirmLabel || t('confirm_ok')}</button>
                </div>
            </div>
        </div>
    );
};

export default ConfirmModal;
