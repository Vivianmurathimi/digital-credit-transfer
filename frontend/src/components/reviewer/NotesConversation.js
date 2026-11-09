import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate, formatDateTime } from '../../dates';
import { authorOf, conversationOf, needsCollapse, NOTE_PREVIEW_LINES } from '../../reviewerList';
import FileLink from './FileLink';

// The notes of one application as one conversation (reviewer Group 5): every note from the
// history in time order, each kind in its own box style, with author, date and time (Budapest),
// and the files a reply added inside that reply's box. Read from application_events.

// Colour cues (reviewer group L2): a light tint and a coloured left border per kind; the kind's
// name, the author and the date stay as text
const BOX_STYLES = {
    student: { background: 'var(--cue-note-student-bg)', border: 'var(--cue-note-student-border)', color: 'var(--text)', icon: '📝' },
    resubmit: { background: 'var(--cue-note-resubmit-bg)', border: 'var(--cue-note-resubmit-border)', color: 'var(--text)', icon: '🔄' },
    reviewer: { background: 'var(--cue-note-reviewer-bg)', border: 'var(--cue-note-reviewer-border)', color: 'var(--text)', icon: '🧾' },
    system: { background: 'var(--cue-note-system-bg)', border: 'var(--cue-note-system-border)', color: 'var(--text)', icon: '⚙️' },
};

// Long text wraps downwards (also long words and URLs); more than about 5 lines collapses
const wrapping = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' };
const clamped = { display: '-webkit-box', WebkitLineClamp: NOTE_PREVIEW_LINES, WebkitBoxOrient: 'vertical', overflow: 'hidden' };

const CollapsibleText = ({ text, id }) => {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const long = needsCollapse(text);
    return (
        <>
            <div id={id} style={{ ...wrapping, ...(long && !expanded ? clamped : null) }}>{text}</div>
            {long && (
                <button
                    type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls={id}
                    style={{ marginTop: '4px', padding: 0, border: 'none', background: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', fontWeight: 'bold', font: 'inherit' }}
                >
                    {expanded ? t('reviewer_show_less') : t('reviewer_show_more')}
                </button>
            )}
        </>
    );
};

const NotesConversation = ({ events, files }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const notes = conversationOf(events);

    if (notes.length === 0) return <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{t('reviewer_no_notes')}</p>;

    const authorText = (event) => {
        const author = authorOf(event);
        return author.name || t(author.labelKey);
    };
    // An automatic rejection shows its reason in the reader's language, not the stored English text
    const noteText = (event) => (event.reason_code
        ? t(`student_reason_${event.reason_code}`, { defaultValue: event.note || '' })
        : event.note || '');

    return (
        <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {notes.map((event) => {
                const style = BOX_STYLES[event.boxType] || BOX_STYLES.system;
                const text = noteText(event);
                return (
                    <li key={event.id} style={{ backgroundColor: style.background, color: style.color, borderLeft: `4px solid ${style.border}`, borderRadius: '5px', padding: '10px 12px', fontSize: '14px', minWidth: 0 }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', justifyContent: 'space-between', marginBottom: '6px' }}>
                            <strong>
                                <span aria-hidden="true">{style.icon} </span>
                                {t(`reviewer_note_type_${event.boxType}`)} · {authorText(event)}
                            </strong>
                            <span style={{ fontSize: '13px', opacity: 0.85 }}>
                                {event.backfilled ? `${formatDate(event.created_at, language)} (${t('reviewer_time_approximate')})` : formatDateTime(event.created_at, language)}
                            </span>
                        </div>
                        {text && <CollapsibleText text={text} id={`note-${event.id}`} />}
                        {(event.files || []).length > 0 && (
                            <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                <span style={{ fontWeight: 'bold', fontSize: '13px' }}>{t('reviewer_reply_files')}</span>
                                {event.files.map((file) => <FileLink key={file} fileName={file} info={files[file]} />)}
                            </div>
                        )}
                    </li>
                );
            })}
        </ol>
    );
};

export default NotesConversation;
