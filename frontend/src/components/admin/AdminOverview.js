import React from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import ReviewerOverview from '../ReviewerOverview';
import { formatDay } from '../../dates';
import { banner, card } from './adminStyles';

// Overview (admin round Group 5): what needs attention, as warning cards that link to their
// section, and quick counts. Each warning appears only when its condition is true. Below: the
// per-programme overview (pending, waiting for the student, reviewer, last day) from Group 7.

const warningCard = banner('danger');
const countBox = { flex: '1 1 140px', padding: '12px', borderRadius: '6px', backgroundColor: 'var(--surface)', border: '1px solid var(--section-border)' };

const AdminOverview = ({ summary }) => {
    const { t, i18n } = useTranslation();
    const language = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2);
    if (!summary) return null;
    const warnings = [
        // Undecided applications from 7 days before the end until the close (admin round Group 7)
        summary.endingSoon && { key: 'admin_warning_ending_soon', to: '/admin/applications', date: formatDay(summary.endingSoon.lastDay, language), pending: summary.endingSoon.pending, needsInfo: summary.endingSoon.needsInfo },
        // The active semester's last day has passed (admin round Group 6)
        summary.readyToClose && { key: 'admin_warning_ready_to_close', to: '/admin/semesters', name: summary.activeSemester?.name },
        !summary.activeSemester && { key: 'admin_warning_no_semester', to: '/admin/semesters' },
        summary.activeSemester && summary.programmesWithoutCourses > 0 && { key: 'admin_warning_no_courses', to: '/admin/catalogue', count: summary.programmesWithoutCourses },
        summary.programmesWithoutReviewer > 0 && { key: 'admin_warning_no_reviewer', to: '/admin/reviewers', count: summary.programmesWithoutReviewer },
        summary.programmesWithoutMain > 0 && { key: 'admin_warning_no_main', to: '/admin/reviewers', count: summary.programmesWithoutMain },
        summary.domains === 0 && { key: 'domains_empty_warning', to: '/admin/domains' },
    ].filter(Boolean);

    return (
        <>
            <section aria-labelledby="overview-title" style={card}>
                <h2 id="overview-title" style={{ marginTop: 0, color: 'var(--heading)' }}>{t('admin_menu_overview')}</h2>
                <p style={{ marginTop: 0 }}>
                    {summary.activeSemester ? t('admin_overview_semester', { name: summary.activeSemester.name }) : t('admin_warning_no_semester')}
                </p>
                {warnings.length === 0
                    ? <p role="status" style={{ ...banner('success'), fontWeight: 'bold' }}>{t('admin_overview_all_good')}</p>
                    : warnings.map((w) => (
                        <div key={w.key} role="alert" style={warningCard}>
                            {t(w.key, { count: w.count, name: w.name, date: w.date, pending: w.pending, needsInfo: w.needsInfo })} <Link to={w.to} style={{ color: 'inherit', fontWeight: 'bold' }}>{t('admin_overview_go')}</Link>
                        </div>
                    ))}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '10px' }}>
                    <div style={countBox}><strong style={{ fontSize: '22px' }}>{summary.pending}</strong><div>{t('admin_count_pending')}</div></div>
                    <div style={countBox}><strong style={{ fontSize: '22px' }}>{summary.needsInfo}</strong><div>{t('admin_count_needs_info')}</div></div>
                    <div style={countBox}><strong style={{ fontSize: '22px' }}>{summary.lateAccessActive}</strong><div>{t('admin_count_late_access')}</div></div>
                    <div style={countBox}><strong style={{ fontSize: '22px' }}>{summary.domains}</strong><div>{t('admin_count_domains')}</div></div>
                </div>
            </section>
            {/* Pending applications and reviewers per programme (reviewer Group 7) */}
            <ReviewerOverview />
        </>
    );
};

export default AdminOverview;
