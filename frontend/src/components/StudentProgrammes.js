import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../http';
import { getErrorMessage } from '../errorMessage';
import { formatDateTime } from '../dates';
import { programmeName } from '../programmeName';

// Fixing a student's programme (admin round Group 3): search by name, email or Neptun code, then
// move the student to another programme. The confirmation says how many open applications are
// withdrawn (reason "Programme changed by the administrator") and whether the unsent draft is
// removed; the server does it all in one step and records the change. Each student's past changes
// are listed under them.

// The admin section card (admin round Group 8: same as components/admin/adminStyles.js)
const card = { backgroundColor: 'var(--section-bg)', padding: '20px', borderRadius: '10px', border: '1px solid var(--section-border)', boxShadow: '0 1px 2px var(--shadow-sm)', marginBottom: '30px' };
const td = { padding: '8px', borderBottom: '1px solid var(--border-subtle)', fontSize: '14px', verticalAlign: 'top', overflowWrap: 'anywhere' };
const th = { padding: '8px', textAlign: 'left', borderBottom: '2px solid var(--border)', fontSize: '14px' };
const MIN_SEARCH = 2;

const StudentProgrammes = () => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const [query, setQuery] = useState('');
    const [students, setStudents] = useState(null);
    const [programmes, setProgrammes] = useState([]);
    const [choice, setChoice] = useState({}); // student id -> programme code picked
    const [history, setHistory] = useState({}); // student id -> changes
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    useEffect(() => {
        http.get('programmes').json().then((data) => setProgrammes(data.programmes || [])).catch(() => setProgrammes([]));
    }, []);

    const search = async (e) => {
        e?.preventDefault();
        setError('');
        setNotice('');
        if (query.trim().length < MIN_SEARCH) { setError(t('errors.INVALID_SEARCH')); return; }
        try {
            const data = await http.get('admin/students', { searchParams: { q: query.trim() } }).json();
            setStudents(data.students);
            setHistory({});
        } catch (err) { setError(getErrorMessage(err, t, 'students_search_failed')); }
    };

    const showHistory = async (student) => {
        try {
            const data = await http.get(`admin/students/${student.id}/programme-changes`).json();
            setHistory((prev) => ({ ...prev, [student.id]: data.changes }));
        } catch (err) { setError(getErrorMessage(err, t, 'students_history_failed')); }
    };

    const change = async (student) => {
        const code = choice[student.id];
        const target = programmes.find((p) => p.code === code);
        if (!target) return;
        const confirmText = [
            t('students_confirm_change', { name: student.name, from: programmeName(student.programme, i18n) || '—', to: programmeName(target, i18n) }),
            t('students_confirm_withdraw', { count: student.open_count }),
            student.has_draft ? t('students_confirm_draft') : '',
        ].filter(Boolean).join('\n\n');
        if (!window.confirm(confirmText)) return;
        setError('');
        try {
            const result = await http.put(`admin/students/${student.id}/programme`, { json: { programme_code: code } }).json();
            setNotice(t('students_changed', { name: student.name, count: result.withdrawn }));
            await search();
        } catch (err) { setError(getErrorMessage(err, t, 'students_change_failed')); }
    };

    return (
        <section aria-labelledby="students-title" style={card}>
            <h2 id="students-title" style={{ marginTop: 0, color: 'var(--heading)' }}>{t('students_title')}</h2>
            <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{t('students_intro')}</p>
            <form onSubmit={search} role="search" style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '15px' }}>
                <label htmlFor="students-q" style={{ position: 'absolute', left: '-9999px' }}>{t('students_search_label')}</label>
                <input
                    id="students-q" type="search" value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('students_search_label')}
                    style={{ flex: '1 1 240px', padding: '8px', border: '1px solid var(--border-strong)', borderRadius: '4px', font: 'inherit' }}
                />
                <button type="submit" style={{ padding: '9px 16px', backgroundColor: 'var(--brand)', color: 'var(--text-on-primary)', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: 'pointer' }}>
                    {t('students_search_button')}
                </button>
            </form>
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
            {notice && <p role="status" style={{ color: 'var(--success-text)', fontWeight: 'bold' }}>{notice}</p>}

            {students && (students.length === 0 ? <p style={{ color: 'var(--text-muted)' }}>{t('students_none_found')}</p> : (
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr>
                                <th style={th}>{t('staff_name_column')}</th>
                                <th style={th}>{t('staff_email_label')}</th>
                                <th style={th}>{t('students_neptun_column')}</th>
                                <th style={th}>{t('staff_programme_label')}</th>
                                <th style={th}>{t('students_change_column')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {students.map((student) => (
                                <React.Fragment key={student.id}>
                                    <tr>
                                        <td style={td}>{student.name}</td>
                                        <td style={td}>{student.email}</td>
                                        <td style={td}>{student.neptun_code}</td>
                                        <td style={td}>
                                            {student.programme ? programmeName(student.programme, i18n) : '—'}
                                            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('students_open_count', { count: student.open_count })}</div>
                                        </td>
                                        <td style={td}>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                                <label htmlFor={`programme-${student.id}`} style={{ position: 'absolute', left: '-9999px' }}>{t('students_new_programme', { name: student.name })}</label>
                                                <select id={`programme-${student.id}`} value={choice[student.id] || ''} onChange={(e) => setChoice((prev) => ({ ...prev, [student.id]: e.target.value }))} style={{ padding: '6px' }}>
                                                    <option value="">{t('staff_programme_choose')}</option>
                                                    {programmes.filter((p) => p.code !== student.programme?.code).map((p) => <option key={p.code} value={p.code}>{programmeName(p, i18n)}</option>)}
                                                </select>
                                                <button type="button" disabled={!choice[student.id]} onClick={() => change(student)} style={{ padding: '5px 10px', borderRadius: '4px', fontWeight: 'bold', cursor: choice[student.id] ? 'pointer' : 'not-allowed', border: '1px solid var(--border-strong)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}>
                                                    {t('students_change_button')}
                                                </button>
                                                <button type="button" onClick={() => showHistory(student)} style={{ padding: '5px 10px', borderRadius: '4px', cursor: 'pointer', border: '1px solid var(--border-strong)', backgroundColor: 'var(--surface)', color: 'var(--link)' }}>
                                                    {t('students_history_button')}
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                    {history[student.id] && (
                                        <tr>
                                            <td colSpan="5" style={{ ...td, backgroundColor: 'var(--surface-2)' }}>
                                                {history[student.id].length === 0 ? t('students_history_empty') : (
                                                    <ul style={{ margin: 0, paddingLeft: '18px' }}>
                                                        {history[student.id].map((c) => (
                                                            <li key={c.id}>
                                                                {t('students_history_line', {
                                                                    date: formatDateTime(c.changed_at, language),
                                                                    from: c.old_programme ? programmeName(c.old_programme, i18n) : '—',
                                                                    to: programmeName(c.new_programme, i18n),
                                                                    name: c.changed_by_name || t('reviewer_decided_by_admin'),
                                                                    count: c.withdrawn_count,
                                                                })}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>
            ))}
        </section>
    );
};

export default StudentProgrammes;
