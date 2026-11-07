import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage } from '../../errorMessage';

// The approve / request information / reject confirmation, unchanged from the old dashboard
// (moved here and from axios to the shared ky client). Notes and decisions are redone in Groups 5 and 6.
const TITLES = { approved: 'reviewer_confirm_title_approved', needs_info: 'reviewer_confirm_title_needs_info', rejected: 'reviewer_confirm_title_rejected' };

const DecisionModal = ({ appId, type, onClose, onDone }) => {
    const { t } = useTranslation();
    const [note, setNote] = useState('');
    const [status, setStatus] = useState('');

    const submit = async () => {
        if (type !== 'approved' && !note.trim()) return alert(t('reviewer_note_required'));
        try {
            setStatus(t('reviewer_decision_submitting'));
            const noteToSend = type === 'approved' ? t('reviewer_confirm_approve_text') : note;
            const data = await http.put(`applications/${appId}/status`, { json: { status: type, note: noteToSend } }).json();
            if (data.success) {
                alert(t('reviewer_application_marked', { status: t(`status_${type}`) }));
                onDone();
            }
        } catch (err) {
            setStatus(getErrorMessage(err, t, 'reviewer_decision_failed'));
        }
    };

    return (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'var(--overlay)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
            <div role="dialog" aria-modal="true" aria-labelledby="decision-title" style={{ backgroundColor: 'var(--surface)', padding: '25px', borderRadius: '10px', width: '400px', maxWidth: '90vw', boxShadow: '0 5px 15px rgba(0,0,0,0.3)' }}>
                <h3 id="decision-title" style={{ marginTop: 0, color: 'var(--link)' }}>{t(TITLES[type] || TITLES.rejected)}</h3>
                {type === 'approved' ? (
                    <p style={{ color: 'var(--link)', fontWeight: 'bold', fontSize: '15px' }}>{t('reviewer_confirm_approve_text')}</p>
                ) : (
                    <>
                        <label htmlFor="decision-note" style={{ fontWeight: 'bold', fontSize: '14px' }}>{t('reviewer_rationale_note_label')}</label>
                        <textarea id="decision-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('reviewer_note_placeholder')} style={{ width: '100%', height: '100px', marginTop: '8px', padding: '10px', boxSizing: 'border-box', border: '1px solid var(--border-strong)', borderRadius: '4px' }} />
                    </>
                )}
                {status && <p style={{ color: 'var(--link)', fontWeight: 'bold', marginTop: '10px' }}>{status}</p>}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                    <button type="button" onClick={onClose} style={{ padding: '8px 15px', cursor: 'pointer', border: '1px solid var(--border-strong)', borderRadius: '4px' }}>{t('reviewer_cancel')}</button>
                    <button type="button" onClick={submit} style={{ padding: '8px 15px', cursor: 'pointer', backgroundColor: 'var(--brand)', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>{t('reviewer_confirm_decision')}</button>
                </div>
            </div>
        </div>
    );
};

export default DecisionModal;
