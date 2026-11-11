/*
 * Colours for the emails and the PDF term book (admin round Group 8).
 * They can't read the app's CSS variables, so the values are copied here, each named after its
 * token in frontend/src/theme/theme.css.
 *
 * KEEP IN STEP: frontend/src/theme/theme.css is the app's one place for colours. When a colour here
 * changes, change it there too (and the other way round). npm test (tests/brandColors.test.js) compares them.
 */
const BRAND_COLORS = {
    brand: '#004085',          // --brand: headings, buttons, links
    red: '#dc3545',            // --red: the password reset email
    text: '#000000',           // --text
    textStrong: '#333333',     // --text-strong: email body text
    textMuted: '#666666',      // --text-muted: small print, PDF labels
    textOnPrimary: '#ffffff',  // --text-on-primary: button text
    line: '#cccccc',           // --border-strong: PDF rules
    panel: '#eef4fb',          // --cue-note-student-bg: the note box in emails
    panelBorder: '#4a7fc1',    // --cue-note-student-border
    // Status text: the same colours as the status chips on every screen (--cue-<status>-text)
    status: {
        pending: '#0b3d7a',
        needs_info: '#6b4400',
        approved: '#17552b',
        rejected: '#8a1c25',
        withdrawn: '#3d4550',
    },
};

// Which theme.css token each value mirrors (used by the check)
const THEME_TOKENS = {
    brand: '--brand', red: '--red', text: '--text', textStrong: '--text-strong', textMuted: '--text-muted',
    textOnPrimary: '--text-on-primary', line: '--border-strong', panel: '--cue-note-student-bg', panelBorder: '--cue-note-student-border',
    'status.pending': '--cue-pending-text', 'status.needs_info': '--cue-needs-info-text', 'status.approved': '--cue-approved-text',
    'status.rejected': '--cue-rejected-text', 'status.withdrawn': '--cue-withdrawn-text',
};

module.exports = { BRAND_COLORS, THEME_TOKENS };
