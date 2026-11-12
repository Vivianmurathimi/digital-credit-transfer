import React from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import ReviewerOverview from '../ReviewerOverview';
import { formatDateTime } from '../../dates';
import { programmeName } from '../../programmeName';
import { banner, card } from './adminStyles';

// Overview (admin round Group 5; round 2 Group 1: several semesters in progress): what needs
// attention, as warning cards that link to their section, and quick counts. Each warning appears
// only when its condition is true; per semester in progress: its review deadline is near (with
// undecided applications), it has passed (nothing was rejected: the undecided counts per
// programme), or everything is decided and it can be closed. Round 2 Group 2: how many await the
// committee, and per programme. Below: the per-programme overview.

const warningCard = banner('danger');
const countBox = { flex: '1 1 140px', padding: '12px', borderRadius: '6px', backgroundColor: 'var(--surface)', border: '1px solid var(--section-border)' };

const AdminOverview = ({ summary }) => {
    const { t, i18n } = useTranslation();
    const language = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2);
    if (!summary) return null;
    const semesters = summary.semesters || [];
    const perSemester = semesters.flatMap((s) => {
        const values = { id: s.id, name: s.name, date: formatDateTime(s.reviewEndsAt, language), pending: s.pending, needsInfo: s.needsInfo };
        return [
            s.reviewSoon && { ...values, key: 'admin_warning_review_soon', to: '/admin/applications' },
            s.reviewPassed && {
                ...values, key: 'admin_warning_review_passed', to: '/admin/applications',
                list: s.undecidedByProgramme.map((p) => t('admin_warning_review_passed_programme', { programme: programmeName(p, i18n), pending: p.pending, needsInfo: p.needs_info })).join('; '),
            },
            s.canClose && { ...values, key: 'admin_warning_ready_to_close', to: '/admin/semesters' },
        ];
    });
    const warnings = [
        ...perSemester,
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
                    {semesters.length > 0 ? t('admin_overview_semester', { name: semesters.map((s) => s.name).join(', ') }) : t('admin_warning_no_semester')}
                </p>
                {warnings.length === 0
                    ? <p role="status" style={{ ...banner('success'), fontWeight: 'bold' }}>{t('admin_overview_all_good')}</p>
                    : warnings.map((w) => (
                        <div key={`${w.key}-${w.id ?? ''}`} role="alert" style={warningCard}>
                            {t(w.key, { count: w.count, name: w.name, date: w.date, pending: w.pending, needsInfo: w.needsInfo, list: w.list })} <Link to={w.to} style={{ color: 'inherit', fontWeight: 'bold' }}>{t('admin_overview_go')}</Link>
                        </div>
                    ))}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '10px' }}>
                    <div style={countBox}><strong style={{ fontSize: '22px' }}>{summary.pending}</strong><div>{t('admin_count_pending')}</div></div>
                    <div style={countBox}><strong style={{ fontSize: '22px' }}>{summary.needsInfo}</strong><div>{t('admin_count_needs_info')}</div></div>
                    <div style={countBox}><strong style={{ fontSize: '22px' }}>{summary.awaitingCommittee ?? 0}</strong><div>{t('admin_count_awaiting_committee')}</div></div>
                    <div style={countBox}><strong style={{ fontSize: '22px' }}>{summary.lateAccessActive}</strong><div>{t('admin_count_late_access')}</div></div>
                    <div style={countBox}><strong style={{ fontSize: '22px' }}>{summary.domains}</strong><div>{t('admin_count_domains')}</div></div>
                </div>
                {/* Awaiting the committee, per semester in progress and programme (round 2 Group 2) */}
                {semesters.filter((s) => s.awaitingByProgramme?.length > 0).map((s) => (
                    <p key={s.id} style={{ margin: '10px 0 0' }}>
                        <strong>{t('admin_overview_awaiting_committee', { name: s.name })}</strong>{' '}
                        {s.awaitingByProgramme.map((p) => t('admin_overview_awaiting_programme', { programme: programmeName(p, i18n), count: p.awaiting })).join('; ')}{' '}
                        <Link to="/admin/applications" style={{ color: 'var(--link)', fontWeight: 'bold' }}>{t('admin_overview_go')}</Link>
                    </p>
                ))}
            </section>
            {/* Pending applications and reviewers per programme (reviewer Group 7) */}
            <ReviewerOverview />
        </>
    );
};

export default AdminOverview;
