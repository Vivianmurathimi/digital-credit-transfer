import { SECTIONS, sectionForPath, pathOf, badgeFor } from './components/admin/sections';

// The admin menu (admin round Group 5): one URL per section, /admin is Overview, badges only when needed
test('each section opens on its own URL, /admin opens Overview', () => {
    expect(sectionForPath('/admin').id).toBe('overview');
    for (const s of SECTIONS) expect(sectionForPath(pathOf(s)).id).toBe(s.id);
    expect(sectionForPath('/admin/semesters/extra').id).toBe('semesters');
    expect(sectionForPath('/admin/unknown')).toBeNull();
});

test('badges show only when their condition is true', () => {
    const calm = { pending: 0, programmesWithoutReviewer: 0, domains: 1, activeSemester: { id: 1 }, programmesWithoutCourses: 0 };
    expect(SECTIONS.map((s) => badgeFor(s.id, calm)).filter(Boolean)).toEqual([]);
    expect(badgeFor('applications', { ...calm, pending: 3 })).toBe('3');
    expect(badgeFor('reviewers', { ...calm, programmesWithoutReviewer: 2 })).toBe('2');
    expect(badgeFor('domains', { ...calm, domains: 0 })).toBe('!');
    expect(badgeFor('semesters', { ...calm, activeSemester: null })).toBe('!');
});
