import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Navigate, useLocation } from 'react-router-dom';
import http from '../../http';
import { SECTIONS, badgeFor, pathOf, sectionForPath } from './sections';
import AdminOverview from './AdminOverview';
import { SemesterSection, CatalogueSection } from './SemesterCatalogue';
import LateAccess from './LateAccess';
import ApplicationsSection from './ApplicationsSection';
import PastSemesters from './PastSemesters';
import ActAs from './ActAs';
import StaffAccess from '../StaffAccess';
import StudentProgrammes from '../StudentProgrammes';
import AllowedDomains from '../AllowedDomains';

// The admin dashboard (admin round Group 5, B4): a side menu, and only the chosen section below it.
// Every section has its own URL (/admin/<section>), so refresh, back/forward and links work.
// The badges come from GET /api/admin/summary and refresh when the section changes and after a
// change in a section. On a narrow window the menu folds into a "Menu" button at the top.
// The menu only organises the screens: every rule stays on the server.

const NARROW = '(max-width: 800px)';
const useNarrow = () => {
    const query = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(NARROW) : null;
    const [narrow, setNarrow] = useState(query ? query.matches : false);
    useEffect(() => {
        if (!query) return undefined;
        const update = () => setNarrow(query.matches);
        query.addEventListener('change', update);
        return () => query.removeEventListener('change', update);
    }, [query]);
    return narrow;
};

const badgeStyle = { marginLeft: 'auto', minWidth: '20px', padding: '0 6px', borderRadius: '10px', fontSize: '12px', fontWeight: 'bold', textAlign: 'center', backgroundColor: 'var(--cue-rejected-bg)', color: 'var(--cue-rejected-text)', border: '1px solid var(--cue-rejected-border)' };

// onActingStarted: Dashboard swaps to the person's screen (and remembers this section for Exit)
const AdminLayout = ({ onActingStarted }) => {
    const { t } = useTranslation();
    const location = useLocation();
    const narrow = useNarrow();
    const [menuOpen, setMenuOpen] = useState(false);
    const [summary, setSummary] = useState(null);
    const section = sectionForPath(location.pathname);

    const refresh = useCallback(() => {
        http.get('admin/summary').json().then((data) => setSummary(data.summary)).catch(() => setSummary(null));
    }, []);
    useEffect(() => { refresh(); setMenuOpen(false); }, [refresh, location.pathname]);

    if (!section) return <Navigate to="/admin" replace />;

    const startActing = () => onActingStarted(location.pathname);
    const body = {
        overview: <AdminOverview summary={summary} />,
        semesters: <SemesterSection onChange={refresh} />,
        'late-access': <LateAccess onChange={refresh} />,
        catalogue: <CatalogueSection onChange={refresh} />,
        applications: <ApplicationsSection onChange={refresh} />,
        'past-semesters': <PastSemesters />,
        reviewers: <><StaffAccess role="reviewer" onChange={refresh} /><ActAs role="reviewer" onActingStarted={startActing} /></>,
        students: <><StudentProgrammes /><ActAs role="student" onActingStarted={startActing} /></>,
        admins: <StaffAccess role="superadmin" onChange={refresh} />,
        domains: <AllowedDomains onChange={refresh} />,
    }[section.id];

    const menu = (
        <nav aria-label={t('admin_menu_label')}>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {SECTIONS.map((s) => {
                    const badge = badgeFor(s.id, summary);
                    return (
                        <li key={s.id}>
                            <NavLink
                                to={pathOf(s)} end
                                style={({ isActive }) => ({
                                    display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderRadius: '6px', marginBottom: '4px',
                                    textDecoration: 'none', fontWeight: isActive ? 'bold' : 'normal',
                                    color: isActive ? 'var(--text-on-primary)' : 'var(--text)',
                                    backgroundColor: isActive ? 'var(--brand)' : 'transparent',
                                })}
                            >
                                <span>{t(s.labelKey)}</span>
                                {badge && <span style={badgeStyle} aria-label={t('admin_menu_badge', { value: badge })}>{badge}</span>}
                            </NavLink>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );

    return (
        <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', gap: '20px', alignItems: 'flex-start' }}>
            {narrow ? (
                <div style={{ width: '100%' }}>
                    <button
                        type="button" aria-expanded={menuOpen} aria-controls="admin-menu" onClick={() => setMenuOpen((open) => !open)}
                        style={{ width: '100%', padding: '10px', fontWeight: 'bold', borderRadius: '6px', border: '1px solid var(--border-strong)', backgroundColor: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}
                    >
                        ☰ {t('admin_menu_button')}: {t(section.labelKey)}
                    </button>
                    {menuOpen && <div id="admin-menu" style={{ marginTop: '8px', padding: '8px', border: '1px solid var(--border)', borderRadius: '6px', backgroundColor: 'var(--surface)' }}>{menu}</div>}
                </div>
            ) : (
                <aside id="admin-menu" style={{ flex: '0 0 230px', position: 'sticky', top: '10px', padding: '10px', border: '1px solid var(--border)', borderRadius: '8px', backgroundColor: 'var(--surface)' }}>
                    {menu}
                </aside>
            )}
            <main style={{ flex: '1 1 auto', minWidth: 0, width: '100%' }} aria-label={t(section.labelKey)}>
                {body}
            </main>
        </div>
    );
};

export default AdminLayout;
