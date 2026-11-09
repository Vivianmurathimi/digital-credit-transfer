import React from 'react';
import { useTranslation } from 'react-i18next';
import { TABS } from '../../reviewerList';

const LABELS = { pending: 'reviewer_pending_tab', needs_info: 'reviewer_needs_info_tab', completed: 'reviewer_completed_tab' };
// Pending / Needs info / Completed, each with how many rows it has (after search and student filter).
// The active tab (reviewer group L2): tinted, underlined and marked with a check, not by colour alone.
const ReviewerTabs = ({ tab, counts, onChange }) => {
    const { t } = useTranslation();
    return (
        <div role="tablist" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '15px', borderBottom: '1px solid var(--success-border)' }}>
            {TABS.map((name) => (
                <button
                    key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => onChange(name)}
                    style={{
                        padding: '9px 16px', cursor: 'pointer', border: 'none', borderRadius: '8px 8px 0 0', font: 'inherit', fontWeight: tab === name ? 'bold' : 'normal',
                        color: 'var(--link)', backgroundColor: tab === name ? 'var(--cue-tab-active-bg)' : 'transparent',
                        borderBottom: tab === name ? '3px solid var(--cue-row-open-border)' : '3px solid transparent',
                    }}
                >
                    {tab === name && <span aria-hidden="true">✓ </span>}
                    {t(LABELS[name])}
                    <span style={{ backgroundColor: 'var(--cue-tab-badge-bg)', color: 'var(--cue-tab-badge-text)', padding: '1px 8px', borderRadius: '999px', marginLeft: '6px', fontSize: '13px', fontWeight: 'bold' }}>{counts[name]}</span>
                </button>
            ))}
        </div>
    );
};

export default ReviewerTabs;
