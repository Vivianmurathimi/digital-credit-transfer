import React from 'react';
import { useTranslation } from 'react-i18next';

// The committee's choices for an application awaiting it (fixes Part A), shared by the committee
// dashboard and the admin's list (the admin acting as committee):
//   the reviewer approved:  Keep the decision · Change the grade · Change to rejected
//   the reviewer rejected:  Keep the decision · Change to approved
// onAct(action): 'keep' | 'change_grade' | 'change'. The server checks the same rules (utils/committee.js).
export const committeeActionsFor = (reviewerDecision) => (reviewerDecision === 'approved'
    ? [['keep', 'committee_keep_button', 'approve'], ['change_grade', 'committee_change_grade_button', 'info'], ['change', 'committee_change_to_rejected_button', 'reject']]
    : [['keep', 'committee_keep_button', 'approve'], ['change', 'committee_change_to_approved_button', 'info']]);

const CommitteeActions = ({ reviewerDecision, onAct, compact = false }) => {
    const { t } = useTranslation();
    return committeeActionsFor(reviewerDecision).map(([action, labelKey, cue]) => (
        <button
            key={action} type="button" onClick={() => onAct(action)}
            style={{ padding: compact ? '6px 12px' : '8px 14px', borderRadius: compact ? '4px' : '5px', border: 'none', fontWeight: 'bold', cursor: 'pointer', backgroundColor: `var(--cue-btn-${cue})`, color: `var(--cue-btn-${cue}-text)` }}
        >
            {t(labelKey)}
        </button>
    ));
};

export default CommitteeActions;
