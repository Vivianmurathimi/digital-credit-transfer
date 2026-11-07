import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate, formatDateTime } from '../../dates';
import { authorOf, sortEvents } from '../../reviewerList';

// The compact audit trail under the conversation (reviewer Group 5): one line per step with
// date and time (Budapest), what happened, who did it and the status afterwards.

const cell = { padding: '6px 8px', borderBottom: '1px solid var(--border)', verticalAlign: 'top', overflowWrap: 'anywhere' };

const HistoryTable = ({ events }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const rows = sortEvents(events);
    if (rows.length === 0) return null;

    const who = (event) => {
        const author = authorOf(event);
        return author.name || t(author.labelKey);
    };

    return (
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: '13px', backgroundColor: 'var(--surface)' }}>
            <caption style={{ textAlign: 'left', fontWeight: 'bold', padding: '0 0 6px', color: 'var(--text-strong)' }}>{t('reviewer_history_title')}</caption>
            <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
                    <th scope="col" style={{ ...cell, width: '28%' }}>{t('reviewer_history_when')}</th>
                    <th scope="col" style={cell}>{t('reviewer_history_event')}</th>
                    <th scope="col" style={cell}>{t('reviewer_history_who')}</th>
                    <th scope="col" style={{ ...cell, width: '20%' }}>{t('reviewer_history_status')}</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((event) => (
                    <tr key={event.id}>
                        <td style={cell}>
                            {event.backfilled ? `${formatDate(event.created_at, language)} (${t('reviewer_time_approximate')})` : formatDateTime(event.created_at, language)}
                        </td>
                        <td style={cell}>{t(`reviewer_event_${event.kind}`)}</td>
                        <td style={cell}>{who(event)}</td>
                        <td style={cell}>{t(`status_${event.status}`, { defaultValue: event.status })}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
};

export default HistoryTable;
