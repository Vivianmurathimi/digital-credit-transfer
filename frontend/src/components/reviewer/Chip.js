import React from 'react';

// A small coloured label (reviewer group L2). `cue` names a --cue-* colour family from
// theme/theme.css (pending, needs-info, approved, rejected, system, resubmitted, neutral).
// The text (and optional icon) always says what the colour means, so colour is never the only signal.
const Chip = ({ cue = 'neutral', icon = null, children, title }) => (
    <span
        title={title}
        style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 9px', borderRadius: '999px',
            fontSize: '12.5px', fontWeight: 'bold', lineHeight: 1.5, whiteSpace: 'nowrap',
            backgroundColor: `var(--cue-${cue}-bg)`, color: `var(--cue-${cue}-text)`, border: `1px solid var(--cue-${cue}-border)`,
        }}
    >
        {icon && <span aria-hidden="true">{icon}</span>}
        {children}
    </span>
);

export const STATUS_ICONS = { pending: '⏳', 'needs-info': '❓', approved: '✓', rejected: '✗', system: '⚙', neutral: '•' };

export default Chip;
