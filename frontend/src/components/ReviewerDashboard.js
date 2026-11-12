import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../http';
import { getErrorMessage, unpackBlobError } from '../errorMessage';
import downloadPdf from '../downloadPdf';
import { ASSIGNMENT_FILTERS, assignedToSomeoneElse, countsFor, rowsFor } from '../reviewerList';
import ReviewerHeader from './reviewer/ReviewerHeader';
import ReviewerTabs from './reviewer/ReviewerTabs';
import ReviewerSearch from './reviewer/ReviewerSearch';
import ApplicationRow from './reviewer/ApplicationRow';
import DecisionModal from './reviewer/DecisionModal';
import SemesterSelect from './reviewer/SemesterSelect';

// The reviewer dashboard (reviewer Groups 3 and 4): header, tabs, search, the list and, per opened row, the details.
// The backend sends only the reviewer's own programme (completed ones of the current semester
// only); search and the student filter run here, on that list.
// The superadmin sees this dashboard by acting as the reviewer (admin round Group 1): the session
// is then the reviewer's, so nothing here needs to know.
// Past semesters (reviewer group L3): picked in the semester selector, shown read-only with the
// same list, search and details, but without decision buttons.

const EMPTY_TEXT = { pending: 'reviewer_empty_pending', needs_info: 'reviewer_empty_needs_info', completed: 'reviewer_empty_completed' };

const ReviewerDashboard = () => {
    const { t } = useTranslation();
    const [data, setData] = useState(null); // { reviewer, semester, applications }
    const [loadError, setLoadError] = useState('');
    const [tab, setTab] = useState('pending');
    const [query, setQuery] = useState('');
    const [student, setStudent] = useState(null); // { studentId, semesterId, name }
    const [openId, setOpenId] = useState(null);
    const [decision, setDecision] = useState(null); // { app, type }
    const [notice, setNotice] = useState(''); // "Decision saved." after the panel closes
    const [semesters, setSemesters] = useState(null); // { inProgress: [{ id, name, review_ends_at }], past: [{ id, name, ends_on }] }
    const [semesterId, setSemesterId] = useState(null); // null = the current view
    const [assignment, setAssignment] = useState('all'); // all / mine / unassigned (round 2 Group 1)
    const [bookState, setBookState] = useState(''); // '' | 'working' | an error text

    const load = useCallback(async () => {
        try {
            const params = semesterId ? { semester: semesterId } : {};
            setData(await http.get('reviewer/applications', { searchParams: params }).json());
            setLoadError('');
        } catch (err) {
            setLoadError(getErrorMessage(err, t, 'reviewer_load_failed'));
        }
    }, [semesterId, t]);

    useEffect(() => { load(); }, [load]);

    // The semesters for the selector (shown only when there are past ones)
    useEffect(() => {
        let current = true;
        http.get('reviewer/semesters').json()
            .then((result) => { if (current) setSemesters(result); })
            .catch((err) => console.error('Could not load the semesters', err));
        return () => { current = false; };
    }, []);

    const readOnly = !!data?.read_only;
    const chooseSemester = (id, isPast = false) => {
        setSemesterId(id);
        setData(null);
        setOpenId(null);
        setStudent(null);
        setNotice('');
        // A past semester's applications are decided: start on Completed
        setTab(isPast ? 'completed' : 'pending');
    };

    const applications = useMemo(() => data?.applications || [], [data]);
    const me = data?.reviewer?.id ?? null;
    // Past semesters are read-only: nothing to share there, so no assignment filter
    const assignmentFilter = readOnly ? 'all' : assignment;
    const rows = useMemo(() => rowsFor(applications, { tab, query, student, assignment: assignmentFilter, me }), [applications, tab, query, student, assignmentFilter, me]);
    const counts = useMemo(() => countsFor(applications, { query, student, assignment: assignmentFilter, me }), [applications, query, student, assignmentFilter, me]);
    // Deciding an application assigned to someone else is allowed after a confirmation (the first decision wins)
    const startDecision = (app, type) => {
        if (assignedToSomeoneElse(app, me) && !window.confirm(t('reviewer_decide_assigned_confirm', { name: app.assigned_name || '—' }))) return;
        setNotice('');
        setDecision({ app, type });
    };

    const showStudent = (app) => {
        setStudent({ studentId: app.student_id, semesterId: app.semester_id ?? null, name: app.student_name });
        setQuery('');
    };

    // Why the list is empty: nothing in this tab at all, or nothing matching the search / student filter
    const emptyText = () => {
        if (readOnly && rowsFor(applications, { tab }).length === 0) return t('reviewer_empty_past');
        if (tab === 'completed' && data && !data.semester) return t('reviewer_no_semester');
        const anyInTab = rowsFor(applications, { tab }).length > 0; // the search, student or assignment filter hides them
        return anyInTab ? t('reviewer_no_search_results') : t(EMPTY_TEXT[tab]);
    };

    return (
        <div style={{ backgroundColor: 'var(--success-surface)', padding: '20px', borderRadius: '10px', border: '2px solid var(--success-border)' }}>
            <ReviewerHeader reviewer={data?.reviewer} semester={data?.semester} semesters={readOnly ? null : data?.semesters} />
            {loadError && <div role="alert" style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', padding: '10px', borderRadius: '5px', marginBottom: '15px', border: '1px solid var(--danger-border)' }}>{loadError}</div>}

            <SemesterSelect semesters={semesters} value={semesterId} onChange={chooseSemester} />
            {/* The PDF book of the reviewer's programmes (round 2 Group 1): the chosen semester, or the only one in
                progress; interim (not final) until the semester closes */}
            {(() => {
                const inProgress = semesters?.inProgress || [];
                const bookSemester = semesterId || (inProgress.length === 1 ? inProgress[0].id : null);
                if (!data || (!bookSemester && inProgress.length < 2)) return null;
                const save = async () => {
                    setBookState('working');
                    try { await downloadPdf(`reviewer/book.pdf?semester=${bookSemester}`, 'book.pdf'); setBookState(''); }
                    catch (err) { setBookState(getErrorMessage(await unpackBlobError(err), t, 'pdf_download_failed')); }
                };
                return (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
                        {bookSemester ? (
                            <button type="button" onClick={save} disabled={bookState === 'working'}
                                style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border-strong)', backgroundColor: 'var(--surface)', color: 'var(--link)', fontWeight: 'bold', cursor: 'pointer', font: 'inherit' }}>
                                {bookState === 'working' ? t('pdf_working') : t(readOnly ? 'pdf_download_book' : 'pdf_download_book_interim')}
                            </button>
                        ) : <span style={{ color: 'var(--text-secondary)' }}>{t('pdf_choose_semester')}</span>}
                        {bookState && bookState !== 'working' && <span role="alert" style={{ color: 'var(--error-text)' }}>{bookState}</span>}
                    </div>
                );
            })()}
            {readOnly && (
                <div role="note" style={{ backgroundColor: 'var(--cue-system-bg)', color: 'var(--cue-system-text)', border: '1px solid var(--cue-system-border)', borderLeft: '4px solid var(--cue-note-system-border)', padding: '10px 12px', borderRadius: '5px', marginBottom: '15px', fontWeight: 'bold' }}>
                    <span aria-hidden="true">🔒 </span>{t('reviewer_past_banner', { name: data.semester?.name || '' })}
                </div>
            )}
            {notice && <div role="status" style={{ backgroundColor: 'var(--success-bg)', color: 'var(--success-text)', padding: '10px', borderRadius: '5px', marginBottom: '15px', border: '1px solid var(--success-border)' }}>{notice}</div>}
            <ReviewerTabs tab={tab} counts={counts} onChange={(name) => { setTab(name); setOpenId(null); }} />
            <ReviewerSearch query={query} onQueryChange={setQuery} student={student} onClearStudent={() => setStudent(null)} />
            {!readOnly && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', margin: '0 0 12px' }}>
                    <label htmlFor="reviewer-assignment">{t('reviewer_assignment_label')}</label>
                    <select id="reviewer-assignment" value={assignment} onChange={(e) => { setAssignment(e.target.value); setOpenId(null); }} style={{ padding: '6px' }}>
                        {ASSIGNMENT_FILTERS.map((name) => <option key={name} value={name}>{t(`reviewer_assignment_${name}`)}</option>)}
                    </select>
                </div>
            )}

            {!data && !loadError ? (
                <p role="status" style={{ color: 'var(--text-muted)' }}>{t('reviewer_loading')}</p>
            ) : rows.length === 0 ? (
                <p role="status" style={{ textAlign: 'center', padding: '20px', backgroundColor: 'var(--surface)', borderRadius: '8px', color: 'var(--text-secondary)' }}>{emptyText()}</p>
            ) : (
                <ul style={{ padding: 0, margin: 0 }}>
                    {rows.map((app) => (
                        <ApplicationRow
                            key={app.id} app={app} open={openId === app.id} readOnly={readOnly}
                            showProgramme={(data?.reviewer?.programmes || []).filter((p) => p.sees).length > 1}
                            onToggle={() => setOpenId(openId === app.id ? null : app.id)}
                            onShowStudent={() => showStudent(app)}
                            me={me}
                            onDecide={(type) => startDecision(app, type)}
                        />
                    ))}
                </ul>
            )}

            {decision && (
                <DecisionModal
                    app={decision.app} type={decision.type}
                    onClose={() => setDecision(null)}
                    onDone={(saved) => {
                        setDecision(null);
                        setNotice(saved ? t('reviewer_decision_saved') : '');
                        setOpenId(null);
                        load();
                    }}
                />
            )}
        </div>
    );
};

export default ReviewerDashboard;
