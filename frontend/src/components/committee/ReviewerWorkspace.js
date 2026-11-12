import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import ReviewerDashboard from '../ReviewerDashboard';
import CommitteeDashboard from './CommitteeDashboard';

// A reviewer's screen (round 2 Group 2). Someone who is a reviewer AND sits on a committee (an
// account with both kinds of link) gets a switch between "Reviewer" and "Committee". Whether they
// have committee links is asked from the server (GET /api/committee/me: 403 without any).
const ReviewerWorkspace = () => {
    const { t } = useTranslation();
    const [onCommittee, setOnCommittee] = useState(false);
    const [view, setView] = useState('reviewer');

    useEffect(() => {
        let current = true;
        http.get('committee/me').json()
            .then((data) => { if (current) setOnCommittee((data.programmes || []).length > 0); })
            .catch(() => { if (current) setOnCommittee(false); });
        return () => { current = false; };
    }, []);

    if (!onCommittee) return <ReviewerDashboard />;
    const tab = (name) => (
        <button type="button" role="tab" aria-selected={view === name} onClick={() => setView(name)}
            style={{ padding: '8px 16px', borderRadius: '6px 6px 0 0', border: '1px solid var(--border-strong)', borderBottom: 'none', cursor: 'pointer', font: 'inherit', fontWeight: 'bold',
                backgroundColor: view === name ? 'var(--brand)' : 'var(--surface)', color: view === name ? 'var(--text-on-primary)' : 'var(--link)' }}>
            {t(`workspace_${name}`)}
        </button>
    );
    return (
        <>
            <div role="tablist" aria-label={t('workspace_label')} style={{ display: 'flex', gap: '6px' }}>
                {tab('reviewer')}
                {tab('committee')}
            </div>
            {view === 'reviewer' ? <ReviewerDashboard /> : <CommitteeDashboard />}
        </>
    );
};

export default ReviewerWorkspace;
