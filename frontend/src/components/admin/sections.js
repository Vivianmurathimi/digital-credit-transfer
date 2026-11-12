// The admin menu (admin round Group 5, B4): one entry per section, in menu order. Each section has
// its own URL (/admin/<path>; /admin is Overview). `components` lists the screens a section shows:
// every admin screen of Groups 1-5 appears in exactly one section (npm run check:admin-menu).
// Group 6 added "Past semesters", Group 7 "Analytics".

export const SECTIONS = [
    { id: 'overview', path: '', labelKey: 'admin_menu_overview', components: ['ReviewerOverview', 'AdminOverview'] },
    { id: 'semesters', path: 'semesters', labelKey: 'admin_menu_semesters', components: ['Semesters', 'PeriodControls'] },
    { id: 'late-access', path: 'late-access', labelKey: 'admin_menu_late_access', components: ['LateAccess'] },
    { id: 'catalogue', path: 'catalogue', labelKey: 'admin_menu_catalogue', components: ['CatalogueImport', 'Catalogue'] },
    { id: 'applications', path: 'applications', labelKey: 'admin_menu_applications', components: ['ApplicationsSection'] },
    { id: 'past-semesters', path: 'past-semesters', labelKey: 'admin_menu_past_semesters', components: ['PastSemesters', 'TermArchive'] },
    { id: 'analytics', path: 'analytics', labelKey: 'admin_menu_analytics', components: ['Analytics'] },
    { id: 'reviewers', path: 'reviewers', labelKey: 'admin_menu_reviewers', components: ['StaffAccess:reviewer', 'ReviewerSharing', 'ActAs:reviewer'] },
    { id: 'students', path: 'students', labelKey: 'admin_menu_students', components: ['StudentProgrammes', 'ActAs:student'] },
    { id: 'admins', path: 'admins', labelKey: 'admin_menu_admins', components: ['StaffAccess:superadmin'] },
    { id: 'domains', path: 'domains', labelKey: 'admin_menu_domains', components: ['AllowedDomains'] },
];

// The section for a URL ("/admin/semesters" -> semesters); anything unknown -> Overview
export const sectionForPath = (pathname) => {
    const rest = String(pathname || '').replace(/^\/admin\/?/, '').split('/')[0];
    return SECTIONS.find((s) => s.path === rest) || null;
};

export const pathOf = (section) => (section.path ? `/admin/${section.path}` : '/admin');

/**
 * The badge of a menu item, from GET /api/admin/summary, or null (no badge). A badge appears only
 * when something needs attention.
 */
export const badgeFor = (sectionId, summary) => {
    if (!summary) return null;
    switch (sectionId) {
        case 'applications': return summary.pending > 0 ? String(summary.pending) : null;
        // programmes nobody can review, and (round 2) programmes whose main reviewer is gone while an extra one assists
        case 'reviewers': { const n = (summary.programmesWithoutReviewer || 0) + (summary.programmesWithoutMain || 0); return n > 0 ? String(n) : null; }
        case 'domains': return summary.domains === 0 ? '!' : null;
        // No active semester, programmes without courses, or the active one is ready to close (Group 6)
        case 'semesters': return !summary.activeSemester || summary.programmesWithoutCourses > 0 || summary.readyToClose ? '!' : null;
        default: return null;
    }
};
