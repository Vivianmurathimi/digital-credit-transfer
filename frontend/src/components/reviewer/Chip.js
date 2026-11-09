import React from 'react';

// A small coloured label (reviewer group L2). `cue` names a --cue-* colour family from
// theme/theme.css (pending, needs-info, approved, rejected, system, resubmitted, neutral).
// The text (and optional icon) always says what the colour means, so colour is never the only signal.
// size "large": the outcome of a decided application (Approved / Rejected), so it stands out.
const Chip = ({ cue = 'neutral', icon = null, size = 'normal', children, title }) => (
    <span
        title={title}
        style={{
            display: 'inline-flex', alignItems: 'center', gap: size === 'large' ? '6px' : '4px', borderRadius: '999px',
            padding: size === 'large' ? '4px 14px' : '2px 9px', fontSize: size === 'large' ? '15px' : '12.5px',
            fontWeight: 'bold', lineHeight: 1.5, whiteSpace: 'nowrap',
            backgroundColor: `var(--cue-${cue}-bg)`, color: `var(--cue-${cue}-text)`, border: `1px solid var(--cue-${cue}-border)`,
        }}
    >
        {icon && <span aria-hidden="true">{icon}</span>}
        {children}
    </span>
);

export const STATUS_ICONS = { pending: '⏳', 'needs-info': '❓', approved: '✓', rejected: '✗', system: '⚙', neutral: '•' };

export default Chip;
