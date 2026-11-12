import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../../dates';
import { gradeText } from '../../grades';
import Chip from '../reviewer/Chip';

// What the committee did with a decision (round 2 Group 2): Kept or Changed, the final result with
// its grade and date, and the committee's note. Shown to reviewers and the admin. Who in the committee
// acted (member name, or "Admin, as committee") only when the server sends it: the admin's views.
// Nothing for decisions that never went to the committee, or that still await it.
export const committeeHandled = (state) => state === 'kept' || state === 'changed';

const CommitteeOutcome = ({ status, finalGrade, state, at, note, byRole = null, byName = null, compact = false }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    if (!committeeHandled(state)) return null;
    const who = byRole === 'admin' ? t('committee_by_admin') : byRole === 'committee' ? (byName || t('reviewer_author_committee')) : null;
    return (
        <div style={{ marginTop: compact ? '4px' : '8px', fontSize: compact ? '13px' : undefined }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }}>
                <Chip cue={state === 'kept' ? 'approved' : 'needs-info'}>{t(`committee_state_${state}`)}</Chip>
                <span>
                    {t('committee_final_line', {
                        status: t(`status_${status}`),
                        grade: status === 'approved' && finalGrade ? `, ${gradeText(finalGrade, t, language)}` : '',
                        date: at ? formatDate(at, language) : '—',
                    })}
                    {who && ` · ${t('committee_acted_by', { who })}`}
                </span>
            </div>
            {note && (
                <div style={{ marginTop: '4px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {t('committee_note_line', { note })}
                </div>
            )}
        </div>
    );
};

export default CommitteeOutcome;
