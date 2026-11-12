import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage } from '../../errorMessage';
import { programmeName } from '../../programmeName';

// The committee member's dashboard (round 2 Group 2). After a reviewer (or an admin) decides, the
// programme's committee confirms it: keep or change. Part A: who the member is and which programmes'
// committees they sit on (read from their current links on the server). The list of decisions to
// confirm comes in Part C. A member with no current programme sees nothing.
const CommitteeDashboard = () => {
    const { t, i18n } = useTranslation();
    const [me, setMe] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        let current = true;
        http.get('committee/me').json()
            .then((data) => { if (current) setMe(data); })
            .catch((err) => { if (current) setError(getErrorMessage(err, t, 'committee_load_failed')); });
        return () => { current = false; };
    }, [t]);

    return (
        <div style={{ backgroundColor: 'var(--surface)', padding: '20px', borderRadius: '10px', border: '2px solid var(--section-border)' }}>
            <h2 style={{ margin: 0, color: 'var(--heading)' }}>{t('committee_title')}</h2>
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
            {me && (me.programmes.length === 0 ? (
                <p role="status" style={{ color: 'var(--text-secondary)' }}>{t('committee_no_programme')}</p>
            ) : (
                <>
                    <p style={{ color: 'var(--text-secondary)' }}>{t('committee_programmes', { programmes: me.programmes.map((p) => programmeName(p, i18n)).join(', ') })}</p>
                    <p style={{ color: 'var(--text-muted)' }}>{t('committee_intro')}</p>
                </>
            ))}
        </div>
    );
};

export default CommitteeDashboard;
