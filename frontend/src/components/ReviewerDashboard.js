import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../http';
import { getErrorMessage } from '../errorMessage';
import { countsFor, rowsFor } from '../reviewerList';
import ReviewerHeader from './reviewer/ReviewerHeader';
import ReviewerTabs from './reviewer/ReviewerTabs';
import ReviewerSearch from './reviewer/ReviewerSearch';
import ApplicationRow from './reviewer/ApplicationRow';
import DecisionModal from './reviewer/DecisionModal';

// The reviewer dashboard (reviewer Group 3): header, tabs, search and the list.
// The backend sends only the reviewer's own programme (completed ones of the current semester
// only); search and the student filter run here, on that list.
// userId / isImpersonating: set while the superadmin looks at a reviewer's dashboard: the
// backend then answers for that reviewer (?as_reviewer=, a view filter only).

const EMPTY_TEXT = { pending: 'reviewer_empty_pending', needs_info: 'reviewer_empty_needs_info', completed: 'reviewer_empty_completed' };

const ReviewerDashboard = ({ userId, isImpersonating = false }) => {
    const { t } = useTranslation();
    const [data, setData] = useState(null); // { reviewer, semester, applications }
    const [loadError, setLoadError] = useState('');
    const [tab, setTab] = useState('pending');
    const [query, setQuery] = useState('');
    const [student, setStudent] = useState(null); // { studentId, semesterId, name }
    const [openId, setOpenId] = useState(null);
    const [decision, setDecision] = useState(null); // { appId, type }

    const load = useCallback(async () => {
        try {
            const searchParams = isImpersonating ? { as_reviewer: userId } : undefined;
            setData(await http.get('reviewer/applications', { searchParams }).json());
            setLoadError('');
        } catch (err) {
            setLoadError(getErrorMessage(err, t, 'reviewer_load_failed'));
        }
    }, [isImpersonating, userId, t]);

    useEffect(() => { load(); }, [load]);

    const applications = useMemo(() => data?.applications || [], [data]);
    const rows = useMemo(() => rowsFor(applications, { tab, query, student }), [applications, tab, query, student]);
    const counts = useMemo(() => countsFor(applications, { query, student }), [applications, query, student]);

    const showStudent = (app) => {
        setStudent({ studentId: app.student_id, semesterId: app.semester_id ?? null, name: app.student_name });
        setQuery('');
    };

    // Why the list is empty: nothing in this tab at all, or nothing matching the search / student filter
    const emptyText = () => {
        if (tab === 'completed' && data && !data.semester) return t('reviewer_no_semester');
        const anyInTab = rowsFor(applications, { tab }).length > 0;
        return anyInTab ? t('reviewer_no_search_results') : t(EMPTY_TEXT[tab]);
    };

    return (
        <div style={{ backgroundColor: 'var(--success-surface)', padding: '20px', borderRadius: '10px', border: '2px solid var(--success-border)' }}>
            <ReviewerHeader reviewer={data?.reviewer} semester={data?.semester} />
            {loadError && <div role="alert" style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', padding: '10px', borderRadius: '5px', marginBottom: '15px', border: '1px solid var(--danger-border)' }}>{loadError}</div>}

            <ReviewerTabs tab={tab} counts={counts} onChange={(name) => { setTab(name); setOpenId(null); }} />
            <ReviewerSearch query={query} onQueryChange={setQuery} student={student} onClearStudent={() => setStudent(null)} />

            {!data && !loadError ? (
                <p role="status" style={{ color: 'var(--text-muted)' }}>{t('reviewer_loading')}</p>
            ) : rows.length === 0 ? (
                <p role="status" style={{ textAlign: 'center', padding: '20px', backgroundColor: 'var(--surface)', borderRadius: '8px', color: 'var(--text-secondary)' }}>{emptyText()}</p>
            ) : (
                <ul style={{ padding: 0, margin: 0 }}>
                    {rows.map((app) => (
                        <ApplicationRow
                            key={app.id} app={app} open={openId === app.id}
                            onToggle={() => setOpenId(openId === app.id ? null : app.id)}
                            onShowStudent={() => showStudent(app)}
                            onDecide={(appId, type) => setDecision({ appId, type })}
                        />
                    ))}
                </ul>
            )}

            {decision && (
                <DecisionModal
                    appId={decision.appId} type={decision.type}
                    onClose={() => setDecision(null)}
                    onDone={() => { setDecision(null); load(); }}
                />
            )}
        </div>
    );
};

export default ReviewerDashboard;
