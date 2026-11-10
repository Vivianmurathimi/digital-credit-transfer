import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage } from '../../errorMessage';
import { programmeName } from '../../programmeName';
import { card, input, label, smallButton, td, th } from './adminStyles';

// The Neptun import (admin round Group 4): upload a CSV, see the preview (nothing is saved yet),
// choose Keep / Hide / Delete for everything missing from the file, then confirm. Delete is greyed
// out with the reason when the item is in use; the server checks it again and saves everything in
// one step. The same file is sent again on confirm, with the preview's fingerprint.

const DEFAULT_OPTIONS = ['keep', 'hide', 'delete'];

const List = ({ title, items, render, empty }) => (
    <div style={{ marginTop: '12px' }}>
        <h4 style={{ margin: '0 0 6px' }}>{title} ({items.length})</h4>
        {items.length === 0 ? <p style={{ margin: 0, color: 'var(--text-muted)' }}>{empty}</p> : (
            <ul style={{ margin: 0, paddingLeft: '18px', maxHeight: '220px', overflowY: 'auto' }}>{items.map(render)}</ul>
        )}
    </div>
);

const CatalogueImport = ({ semesters, onImported }) => {
    const { t, i18n } = useTranslation();
    const choosable = semesters.filter((s) => s.status !== 'closed');
    const [semesterId, setSemesterId] = useState('');
    const [file, setFile] = useState(null);
    const [preview, setPreview] = useState(null);
    const [decisions, setDecisions] = useState({ programmes: {}, courses: {} });
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);

    const formData = (extra = {}) => {
        const body = new FormData();
        body.append('file', file);
        body.append('semester_id', semesterId);
        Object.entries(extra).forEach(([key, value]) => body.append(key, value));
        return body;
    };

    const runPreview = async (e) => {
        e.preventDefault();
        setError('');
        setNotice('');
        setPreview(null);
        if (!semesterId || !file) { setError(t('import_choose_both')); return; }
        setBusy(true);
        try {
            const data = await http.post('admin/catalogue/preview', { body: formData() }).json();
            setPreview(data.preview);
            setDecisions({
                programmes: Object.fromEntries(data.preview.missingProgrammes.map((p) => [p.code, p.default])),
                courses: Object.fromEntries(data.preview.missingCourses.map((c) => [String(c.id), c.default])),
            });
        } catch (err) { setError(getErrorMessage(err, t, 'import_preview_failed')); }
        finally { setBusy(false); }
    };

    const confirm = async () => {
        if (!window.confirm(t('import_confirm'))) return;
        setError('');
        setBusy(true);
        try {
            const { summary } = await http.post('admin/catalogue/import', { body: formData({ hash: preview.hash, decisions: JSON.stringify(decisions) }) }).json();
            setNotice(t('import_done', summary));
            setPreview(null);
            setFile(null);
            onImported();
        } catch (err) { setError(getErrorMessage(err, t, 'import_failed')); }
        finally { setBusy(false); }
    };

    const reasonText = (reasons) => reasons.map((r) => t(`catalogue_blocked_${r}`)).join(' ');
    const decisionSelect = (kind, key, item) => (
        <select
            aria-label={t('import_decision_label', { item: key })}
            value={decisions[kind][key]}
            onChange={(e) => setDecisions((prev) => ({ ...prev, [kind]: { ...prev[kind], [key]: e.target.value } }))}
            style={{ padding: '4px' }}
        >
            {DEFAULT_OPTIONS.map((option) => (
                <option key={option} value={option} disabled={option === 'delete' && !item.canDelete}>
                    {t(`import_decision_${option}`)}{option === 'delete' && !item.canDelete ? ` – ${reasonText(item.blockedBy)}` : ''}
                </option>
            ))}
        </select>
    );

    return (
        <section aria-labelledby="import-title" style={card}>
            <h2 id="import-title" style={{ marginTop: 0, color: 'var(--heading)' }}>{t('import_title')}</h2>
            <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{t('import_intro')}</p>
            <form onSubmit={runPreview} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', alignItems: 'end' }}>
                <div>
                    <label htmlFor="import-semester" style={label}>{t('import_semester_label')}</label>
                    <select id="import-semester" value={semesterId} onChange={(e) => { setSemesterId(e.target.value); setPreview(null); }} style={input}>
                        <option value="">{t('import_semester_choose')}</option>
                        {choosable.map((s) => <option key={s.id} value={s.id}>{s.name} ({t(`semesters_status_${s.status}`)})</option>)}
                    </select>
                </div>
                <div>
                    <label htmlFor="import-file" style={label}>{t('import_file_label')}</label>
                    <input id="import-file" type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files[0] || null); setPreview(null); }} style={input} />
                </div>
                <button type="submit" disabled={busy} style={{ ...smallButton(), padding: '9px 14px', backgroundColor: 'var(--brand)', color: 'var(--text-on-primary)', border: 'none' }}>{t('import_preview_button')}</button>
            </form>
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
            {notice && <p role="status" style={{ color: 'var(--success-text)', fontWeight: 'bold' }}>{notice}</p>}

            {preview && (
                <div style={{ marginTop: '15px', padding: '12px', backgroundColor: 'var(--surface-2)', borderRadius: '6px' }}>
                    <p role="status" style={{ marginTop: 0, fontWeight: 'bold' }}>{t('import_preview_summary', { rows: preview.rows, valid: preview.validRows, errors: preview.errors.length, unchanged: preview.unchangedCourses })}</p>
                    <p style={{ marginTop: 0, color: 'var(--text-muted)' }}>{t('import_nothing_saved')}</p>

                    <List title={t('import_errors_title')} items={preview.errors} empty={t('import_none')}
                        render={(e) => <li key={`${e.row}-${e.code}`} style={{ color: 'var(--error-text)' }}>{t('import_error_row', { row: e.row, reason: t(`import_error_${e.code}`) })}</li>} />
                    <List title={t('import_new_programmes')} items={preview.newProgrammes} empty={t('import_none')}
                        render={(p) => <li key={p.code}>{p.code} – {programmeName(p, i18n)}</li>} />
                    <List title={t('import_changed_programmes')} items={preview.changedProgrammes} empty={t('import_none')}
                        render={(p) => <li key={p.code}>{p.code}: {programmeName(p.before, i18n)} → {programmeName(p.after, i18n)}{p.before.status === 'hidden' ? ` (${t('import_shown_again')})` : ''}</li>} />
                    <List title={t('import_new_courses')} items={preview.newCourses} empty={t('import_none')}
                        render={(c) => <li key={`${c.programme_code}-${c.course_code}`}>{c.programme_code} · {c.course_code} – {c.course_name} ({c.credits})</li>} />
                    <List title={t('import_changed_courses')} items={preview.changedCourses} empty={t('import_none')}
                        render={(c) => (
                            <li key={c.id}>
                                {c.programme_code} · {c.course_code}: {c.before.course_name} ({c.before.credits}) → {c.after.course_name} ({c.after.credits})
                                {c.before.status === 'hidden' ? ` (${t('import_shown_again')})` : ''}
                            </li>
                        )} />

                    <h4 style={{ margin: '16px 0 6px' }}>{t('import_missing_title')}</h4>
                    <p style={{ margin: '0 0 8px', fontSize: '13px', color: 'var(--text-muted)' }}>{t('import_missing_hint')}</p>
                    {preview.missingProgrammes.length + preview.missingCourses.length === 0 ? <p style={{ margin: 0 }}>{t('import_none')}</p> : (
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead><tr><th style={th}>{t('import_missing_item')}</th><th style={th}>{t('import_missing_use')}</th><th style={th}>{t('import_decision_column')}</th></tr></thead>
                                <tbody>
                                    {preview.missingProgrammes.map((p) => (
                                        <tr key={`p-${p.code}`}>
                                            <td style={td}><strong>{t('import_programme_label')}</strong> {p.code} – {programmeName(p, i18n)}</td>
                                            <td style={td}>{p.canDelete ? t('import_not_in_use') : reasonText(p.blockedBy)}</td>
                                            <td style={td}>{decisionSelect('programmes', p.code, p)}</td>
                                        </tr>
                                    ))}
                                    {preview.missingCourses.map((c) => (
                                        <tr key={`c-${c.id}`}>
                                            <td style={td}><strong>{t('import_course_label')}</strong> {c.programme_code} · {c.course_code} – {c.course_name}</td>
                                            <td style={td}>{c.canDelete ? t('import_not_in_use') : reasonText(c.blockedBy)}</td>
                                            <td style={td}>{decisionSelect('courses', String(c.id), c)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <button type="button" onClick={confirm} disabled={busy} style={{ ...smallButton(), marginTop: '12px', padding: '9px 14px', backgroundColor: 'var(--brand)', color: 'var(--text-on-primary)', border: 'none' }}>{t('import_confirm_button')}</button>
                </div>
            )}
        </section>
    );
};

export default CatalogueImport;
