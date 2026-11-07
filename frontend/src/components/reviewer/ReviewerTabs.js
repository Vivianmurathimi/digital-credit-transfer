import React from 'react';
import { useTranslation } from 'react-i18next';
import { TABS } from '../../reviewerList';

const LABELS = { pending: 'reviewer_pending_tab', needs_info: 'reviewer_needs_info_tab', completed: 'reviewer_completed_tab' };
const BADGE_COLORS = { pending: 'var(--request)', needs_info: 'var(--orange)', completed: 'var(--accent)' };

// Pending / Needs info / Completed, each with how many rows it has (after search and student filter)
const ReviewerTabs = ({ tab, counts, onChange }) => {
    const { t } = useTranslation();
    return (
        <div role="tablist" style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '15px', borderBottom: '3px solid var(--success-border)', paddingBottom: '10px' }}>
            {TABS.map((name) => (
                <button
                    key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => onChange(name)}
                    style={{ padding: '10px 20px', cursor: 'pointer', border: 'none', borderRadius: '20px', fontWeight: 'bold', backgroundColor: tab === name ? 'var(--surface)' : 'transparent', color: 'var(--success-text)' }}
                >
                    {t(LABELS[name])}
                    <span style={{ backgroundColor: BADGE_COLORS[name], color: '#fff', padding: '2px 8px', borderRadius: '10px', marginLeft: '5px' }}>{counts[name]}</span>
                </button>
            ))}
        </div>
    );
};

export default ReviewerTabs;
