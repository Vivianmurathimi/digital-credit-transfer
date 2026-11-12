import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../http';
import { formatDay } from '../dates';
import { programmeName } from '../programmeName';

// The admin's banner per programme (reviewer Group 7): how many applications wait for a decision and
// for the student's reply, and when the semester ends (after it, undecided ones are rejected
// automatically). A programme without a main reviewer is shown as a red warning (round 2 Group 1:
// with its extra reviewers, and whether one of them is still assisting).
// Kept minimal: the admin round redesigns the dashboard.

const ReviewerOverview = () => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const [overview, setOverview] = useState(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let active = true;
        http.get('admin/reviewer-overview').json()
            .then((data) => { if (active) setOverview(data); })
            .catch(() => { if (active) setFailed(true); });
        return () => { active = false; };
    }, []);

    if (failed) return <p role="alert" style={{ color: 'var(--error-text)', marginBottom: '20px' }}>{t('admin_overview_failed')}</p>;
    if (!overview) return null;

    const endsOn = overview.semester ? formatDay(overview.semester.endsOn, language) : null;

    return (
        <section aria-labelledby="reviewer-overview-title" style={{ marginBottom: '30px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <h2 id="reviewer-overview-title" style={{ margin: 0, fontSize: '18px', color: 'var(--heading)' }}>{t('admin_overview_title')}</h2>
            {!overview.semester && <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{t('admin_overview_no_semester')}</p>}
            {overview.programmes.map((programme) => {
                const values = { programme: programmeName(programme, i18n), pending: programme.pending, needsInfo: programme.needs_info, date: endsOn };
                const busy = programme.pending + programme.needs_info > 0;
                return (
                    <div key={programme.code} style={{ padding: '10px 14px', borderRadius: '6px', overflowWrap: 'anywhere', ...(busy
                        ? { backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)' }
                        : { backgroundColor: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }) }}>
                        <strong>{t(endsOn ? 'admin_overview_line' : 'admin_overview_line_no_semester', values)}</strong>
                        {programme.reviewer && <div style={{ fontSize: '14px', marginTop: '2px' }}>{t('admin_overview_reviewer', { name: programme.reviewer.name })}</div>}
                        {(programme.extras || []).length > 0 && (
                            <div style={{ fontSize: '14px', marginTop: '2px' }}>
                                {t('admin_overview_extras', { names: programme.extras.map((x) => `${x.name} (${t(x.can_assist ? 'staff_link_assisting' : 'staff_link_standby')})`).join(', ') })}
                            </div>
                        )}
                        {/* No main reviewer: an assisting extra reviewer keeps working; with nobody who can see it, it waits for the admin */}
                        {!programme.reviewer && (
                            <div role="alert" style={{ marginTop: '6px', padding: '6px 10px', borderRadius: '5px', backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', border: '1px solid var(--danger-border)', fontWeight: 'bold' }}>
                                {t((programme.extras || []).some((x) => x.can_assist) ? 'admin_overview_no_main_assisting' : 'admin_overview_no_reviewer')}
                            </div>
                        )}
                    </div>
                );
            })}
        </section>
    );
};

export default ReviewerOverview;
