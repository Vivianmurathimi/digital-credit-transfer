// One status, one look (admin round Group 8): the chip cue for each application status, used on the
// admin, reviewer and student screens alike (components/StatusChip.js). The colours are the --cue-*
// tokens in theme/theme.css; their text passes WCAG AA (npm run check:contrast).
export const STATUS_CUES = {
    pending: 'pending',
    needs_info: 'needs-info',
    approved: 'approved',
    rejected: 'rejected',
    withdrawn: 'withdrawn',
    awaiting_committee: 'awaiting', // round 2 Group 2: decided by a reviewer, waiting for the committee
};

// Anything unexpected looks neutral
export const cueForStatus = (status) => STATUS_CUES[status] || 'neutral';

// The Analytics bar colour of a status (--chart-* tokens)
export const chartColorForStatus = (status) => `var(--chart-${STATUS_CUES[status] || 'neutral'})`;
