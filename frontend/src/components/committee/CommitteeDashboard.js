import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage, unpackBlobError } from '../../errorMessage';
import { programmeName } from '../../programmeName';
import { matchesSearch } from '../../reviewerList';
import downloadPdf from '../../downloadPdf';
import ReviewerSearch from '../reviewer/ReviewerSearch';
import CommitteeRow from './CommitteeRow';
import CommitteeDecisionModal from './CommitteeDecisionModal';

// The committee member's dashboard (round 2 Group 2). After a reviewer (or an admin) decides, the
// programme's committee confirms it: keep or change. Two tabs: Waiting for the committee, and
// Handled; search, programme filter and semester filter (the reviewer list's search). The server
// sends only the member's committee programmes, read from their current links on every request; a
// member with no current programme sees nothing.

const TABS = ['waiting', 'handled'];
const tabButton = (active) => ({
    padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', font: 'inherit', fontWeight: 'bold',
    border: `1px solid ${active ? 'var(--brand)' : 'var(--border-strong)'}`,
    backgroundColor: active ? 'var(--cue-tab-active-bg)' : 'var(--surface)', color: 'var(--link)',
});

const CommitteeDashboard = () => {
    const { t, i18n } = useTranslation();
    const [me, setMe] = useState(null);
    const [lists, setLists] = useState({ waiting: null, handled: null });
    const [tab, setTab] = useState('waiting');
    const [query, setQuery] = useState('');
    const [programme, setProgramme] = useState('');
    const [semester, setSemester] = useState('');
    const [openId, setOpenId] = useState(null);
    const [acting, setActing] = useState(null); // { app, action }
    const [notice, setNotice] = useState('');
    const [error, setError] = useState('');
    const [bookState, setBookState] = useState('');

    const load = useCallback(async () => {
        try {
            const params = { ...(programme ? { programme } : {}), ...(semester ? { semester } : {}) };
            const [meData, waiting, handled] = await Promise.all([
                http.get('committee/me').json(),
                http.get('committee/applications', { searchParams: { tab: 'waiting', ...params } }).json(),
                http.get('committee/applications', { searchParams: { tab: 'handled', ...params } }).json(),
            ]);
            setMe(meData);
            setLists({ waiting: waiting.applications, handled: handled.applications });
            setError('');
        } catch (err) { setError(getErrorMessage(err, t, 'committee_load_failed')); }
    }, [programme, semester, t]);
    useEffect(() => { load(); }, [load]);

    const rows = useMemo(() => (lists[tab] || []).filter((app) => matchesSearch(app, query)), [lists, tab, query]);
    const done = (saved) => {
        setActing(null);
        if (saved) setNotice(t('committee_decision_saved'));
        setOpenId(null);
        load();
    };
    const saveBook = async () => {
        setBookState('working');
        try { await downloadPdf(`committee/book.pdf?semester=${semester}`, 'book.pdf'); setBookState(''); }
        catch (err) { setBookState(getErrorMessage(await unpackBlobError(err), t, 'pdf_download_failed')); }
    };

    return (
        <div style={{ backgroundColor: 'var(--surface)', padding: '20px', borderRadius: '10px', border: '2px solid var(--section-border)' }}>
            <h2 style={{ margin: 0, color: 'var(--heading)' }}>{t('committee_title')}</h2>
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
            {me && me.programmes.length === 0 && <p role="status" style={{ color: 'var(--text-secondary)' }}>{t('committee_no_programme')}</p>}
            {me && me.programmes.length > 0 && (
                <>
                    <p style={{ color: 'var(--text-secondary)', marginTop: '4px' }}>{t('committee_programmes', { programmes: me.programmes.map((p) => programmeName(p, i18n)).join(', ') })}</p>
                    <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{t('committee_intro')}</p>
                    {notice && <div role="status" style={{ backgroundColor: 'var(--success-bg)', color: 'var(--success-text)', padding: '10px', borderRadius: '5px', marginBottom: '12px' }}>{notice}</div>}

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', marginBottom: '12px' }}>
                        {me.programmes.length > 1 && (
                            <label>{t('staff_programme_label')}{' '}
                                <select value={programme} onChange={(e) => setProgramme(e.target.value)} style={{ padding: '6px' }}>
                                    <option value="">{t('committee_all_programmes')}</option>
                                    {me.programmes.map((p) => <option key={p.code} value={p.code}>{programmeName(p, i18n)}</option>)}
                                </select>
                            </label>
                        )}
                        <label>{t('reviewer_semester_label')}{' '}
                            <select value={semester} onChange={(e) => setSemester(e.target.value)} style={{ padding: '6px' }}>
                                <option value="">{t('committee_all_semesters')}</option>
                                {me.semesters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                        </label>
                        {semester ? (
                            <button type="button" onClick={saveBook} disabled={bookState === 'working'}
                                style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border-strong)', backgroundColor: 'var(--surface)', color: 'var(--link)', fontWeight: 'bold', cursor: 'pointer', font: 'inherit' }}>
                                {bookState === 'working' ? t('pdf_working') : t('committee_download_book')}
                            </button>
                        ) : <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>{t('pdf_choose_semester')}</span>}
                        {bookState && bookState !== 'working' && <span role="alert" style={{ color: 'var(--error-text)' }}>{bookState}</span>}
                    </div>

                    <div role="tablist" aria-label={t('committee_title')} style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                        {TABS.map((name) => (
                            <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => { setTab(name); setOpenId(null); }} style={tabButton(tab === name)}>
                                {t(`committee_tab_${name}`)} ({(lists[name] || []).length})
                            </button>
                        ))}
                    </div>
                    <ReviewerSearch query={query} onQueryChange={setQuery} student={null} onClearStudent={() => {}} />

                    {lists[tab] === null ? <p role="status">{t('reviewer_loading')}</p> : rows.length === 0 ? (
                        <p role="status" style={{ textAlign: 'center', padding: '20px', color: 'var(--text-secondary)' }}>
                            {t((lists[tab] || []).length > 0 ? 'reviewer_no_search_results' : `committee_empty_${tab}`)}
                        </p>
                    ) : (
                        <ul style={{ padding: 0, margin: 0 }}>
                            {rows.map((app) => (
                                <CommitteeRow key={app.id} app={app} open={openId === app.id}
                                    onToggle={() => setOpenId(openId === app.id ? null : app.id)}
                                    onAct={(action) => { setNotice(''); setActing({ app, action }); }} />
                            ))}
                        </ul>
                    )}
                </>
            )}
            {acting && (
                <CommitteeDecisionModal app={acting.app} action={acting.action} url={`committee/applications/${acting.app.id}/decision`}
                    onClose={() => setActing(null)} onDone={done} />
            )}
        </div>
    );
};

export default CommitteeDashboard;
