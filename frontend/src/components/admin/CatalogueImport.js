import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage } from '../../errorMessage';
import { programmeName } from '../../programmeName';
import { banner, card, input, label, smallButton, td, th } from './adminStyles';
import ConfirmModal from '../ConfirmModal';

// The Neptun import (admin round Group 4; fixes 1b: one programme per import).
//   1. Programme: an existing one from the list, or a new one (code and names). A new one is checked
//      against the existing ones first; a look-alike stops here with Same programme (use the existing
//      one) or Different programme (create it anyway). The same code can never be created twice.
//   2. The CSV file.
//   3. Every row is checked against the chosen programme. Rows written with another code are listed
//      by group: Treat as the same programme (the code is remembered for later imports) or Cancel the
//      import (nothing saved; fix the file and upload again).
// Then the preview as before (nothing saved yet): Keep / Hide / Delete for the programme's courses
// missing from the file, then Confirm. The server checks everything again and saves in one step.

const DEFAULT_OPTIONS = ['keep', 'hide', 'delete'];
const EMPTY_NEW = { code: '', name_hu: '', name_en: '', name_de: '' };

const List = ({ title, items, render, empty }) => (
    <div style={{ marginTop: '12px' }}>
        <h4 style={{ margin: '0 0 6px' }}>{title} ({items.length})</h4>
        {items.length === 0 ? <p style={{ margin: 0, color: 'var(--text-muted)' }}>{empty}</p> : (
            <ul style={{ margin: 0, paddingLeft: '18px', maxHeight: '220px', overflowY: 'auto' }}>{items.map(render)}</ul>
        )}
    </div>
);

const primaryButton = (disabled) => ({
    ...smallButton(), padding: '9px 14px', backgroundColor: 'var(--brand)', color: 'var(--text-on-primary)', border: 'none',
    ...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
});
const stepTitle = { margin: '16px 0 8px', color: 'var(--heading)' };

const CatalogueImport = ({ semesters, onImported }) => {
    const { t, i18n } = useTranslation();
    const choosable = semesters.filter((s) => s.status !== 'closed');
    const [semesterId, setSemesterId] = useState('');
    const [programmes, setProgrammes] = useState([]);
    // Step 1
    const [mode, setMode] = useState('existing'); // existing | new
    const [programmeId, setProgrammeId] = useState('');
    const [draft, setDraft] = useState(EMPTY_NEW);
    const [check, setCheck] = useState(null); // { programme, lookalikes, codeTaken } of the new programme
    const [chosen, setChosen] = useState(null); // { choice (sent to the server), shown: {code, names, isNew} }
    // Steps 2 and 3
    const [file, setFile] = useState(null);
    const [fileKey, setFileKey] = useState(0); // a new key empties the file input
    const [preview, setPreview] = useState(null);
    const [answers, setAnswers] = useState({}); // step 3: { [code]: 'same' }
    const [decisions, setDecisions] = useState({ courses: {} });
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);

    const loadProgrammes = useCallback(async () => {
        try { setProgrammes((await http.get('admin/programmes').json()).programmes); } catch (err) { setError(getErrorMessage(err, t, 'catalogue_load_failed')); }
    }, [t]);
    useEffect(() => { loadProgrammes(); }, [loadProgrammes]);

    const label2 = (p) => `${p.code} – ${programmeName(p, i18n)}`;
    const resetFile = () => { setFile(null); setFileKey((k) => k + 1); setPreview(null); setAnswers({}); setDecisions({ courses: {} }); };
    const backToStep1 = () => { setChosen(null); setCheck(null); resetFile(); setError(''); };

    // Step 1 -> 2
    const pickExisting = (p) => {
        setChosen({ choice: { id: p.id }, shown: { ...p, isNew: false } });
        setMode('existing');
        setProgrammeId(String(p.id));
        setCheck(null);
        setError('');
    };
    // confirmed: the admin answered Different programme to a look-alike (the server asks for it again)
    const pickNew = (programme, confirmed = false) => {
        setChosen({ choice: { new: programme, ...(confirmed ? { confirmed_different: true } : {}) }, shown: { ...programme, isNew: true } });
        setCheck(null);
        setError('');
    };
    const continueStep1 = async (e) => {
        e.preventDefault();
        setError('');
        setNotice('');
        if (!semesterId) { setError(t('import_choose_semester')); return; }
        if (mode === 'existing') {
            const p = programmes.find((x) => String(x.id) === programmeId);
            if (!p) { setError(t('import_choose_programme')); return; }
            pickExisting(p);
            return;
        }
        setBusy(true);
        try {
            const result = await http.post('admin/catalogue/programme-check', { json: draft }).json();
            if (result.lookalikes.length === 0) pickNew(result.programme);
            else setCheck(result);
        } catch (err) { setError(getErrorMessage(err, t, 'import_check_failed')); }
        finally { setBusy(false); }
    };

    // Steps 2 and 3: the preview, with the answers so far
    const formData = (extra = {}) => {
        const body = new FormData();
        body.append('file', file);
        body.append('semester_id', semesterId);
        body.append('programme', JSON.stringify(chosen.choice));
        Object.entries(extra).forEach(([key, value]) => body.append(key, value));
        return body;
    };
    const loadPreview = async (nextAnswers) => {
        const data = await http.post('admin/catalogue/preview', { body: formData({ mismatches: JSON.stringify(nextAnswers) }) }).json();
        setPreview(data.preview);
        if (data.preview.ready) {
            setDecisions((prev) => ({ courses: Object.fromEntries(data.preview.missingCourses.map((c) => [String(c.id), prev.courses[String(c.id)] || c.default])) }));
        }
    };
    const runPreview = async (e) => {
        e.preventDefault();
        setError('');
        setNotice('');
        setPreview(null);
        setAnswers({});
        setDecisions({ courses: {} });
        if (!file) { setError(t('import_choose_file')); return; }
        setBusy(true);
        try { await loadPreview({}); } catch (err) { setError(getErrorMessage(err, t, 'import_preview_failed')); }
        finally { setBusy(false); }
    };
    const treatAsSame = async (code) => {
        const next = { ...answers, [code]: 'same' };
        setAnswers(next);
        setError('');
        setBusy(true);
        try { await loadPreview(next); } catch (err) { setError(getErrorMessage(err, t, 'import_preview_failed')); }
        finally { setBusy(false); }
    };
    const cancelImport = () => {
        resetFile();
        setError('');
        setNotice(t('import_cancelled'));
    };

    const confirm = async () => {
        setConfirming(false);
        setError('');
        setBusy(true);
        try {
            const { summary } = await http.post('admin/catalogue/import', {
                body: formData({ hash: preview.hash, mismatches: JSON.stringify(answers), decisions: JSON.stringify(decisions) }),
            }).json();
            setNotice([t('import_done', summary), summary.aliasesSaved > 0 && t('import_done_aliases', { count: summary.aliasesSaved })].filter(Boolean).join(' '));
            // A programme created by the import is an existing one from now on
            if (chosen.shown.isNew) setChosen({ choice: { id: summary.programmeId }, shown: { ...chosen.shown, id: summary.programmeId, isNew: false } });
            resetFile();
            loadProgrammes();
            onImported();
        } catch (err) { setError(getErrorMessage(err, t, 'import_failed')); }
        finally { setBusy(false); }
    };

    const reasonText = (reasons) => reasons.map((r) => t(`catalogue_blocked_${r}`)).join(' ');
    const decisionSelect = (key, item) => (
        <select
            aria-label={t('import_decision_label', { item: `${item.course_code}` })}
            value={decisions.courses[key]}
            onChange={(e) => setDecisions((prev) => ({ courses: { ...prev.courses, [key]: e.target.value } }))}
            style={{ padding: '4px' }}
        >
            {DEFAULT_OPTIONS.map((option) => (
                <option key={option} value={option} disabled={option === 'delete' && !item.canDelete}>
                    {t(`import_decision_${option}`)}{option === 'delete' && !item.canDelete ? ` – ${reasonText(item.blockedBy)}` : ''}
                </option>
            ))}
        </select>
    );
    const setDraftField = (field) => (e) => { setDraft((prev) => ({ ...prev, [field]: e.target.value })); setCheck(null); };
    const chosenText = chosen && `${label2(chosen.shown)}${chosen.shown.isNew ? ` ${t('import_into_new')}` : ''}`;
    const groups = preview?.mismatches || [];

    return (
        <section aria-labelledby="import-title" style={card}>
            <h2 id="import-title" style={{ marginTop: 0, color: 'var(--heading)' }}>{t('import_title')}</h2>
            <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{t('import_intro')}</p>

            {/* Step 1: the semester and the programme */}
            <h3 style={stepTitle}>{t('import_step_programme')}</h3>
            {chosen ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                    <p role="status" style={{ margin: 0, fontWeight: 'bold' }}>{t('import_into', { semester: (choosable.find((s) => String(s.id) === semesterId) || {}).name, programme: chosenText })}</p>
                    <button type="button" style={smallButton()} disabled={busy} onClick={backToStep1}>{t('import_change_programme')}</button>
                </div>
            ) : (
                <form onSubmit={continueStep1}>
                    <div style={{ maxWidth: '360px', marginBottom: '12px' }}>
                        <label htmlFor="import-semester" style={label}>{t('import_semester_label')}</label>
                        <select id="import-semester" value={semesterId} onChange={(e) => setSemesterId(e.target.value)} style={input}>
                            <option value="">{t('import_semester_choose')}</option>
                            {choosable.map((s) => <option key={s.id} value={s.id}>{s.name} ({t(`semesters_status_${s.status}`)})</option>)}
                        </select>
                    </div>
                    <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
                        <legend style={label}>{t('import_programme_legend')}</legend>
                        {['existing', 'new'].map((value) => (
                            <label key={value} style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', marginRight: '16px' }}>
                                <input type="radio" name="import-programme-mode" value={value} checked={mode === value} onChange={() => { setMode(value); setCheck(null); setError(''); }} />
                                {t(`import_programme_${value}`)}
                            </label>
                        ))}
                    </fieldset>
                    {mode === 'existing' ? (
                        <div style={{ maxWidth: '480px' }}>
                            <label htmlFor="import-programme" style={label}>{t('import_programme_select')}</label>
                            <select id="import-programme" value={programmeId} onChange={(e) => setProgrammeId(e.target.value)} style={input}>
                                <option value="">{t('import_programme_choose')}</option>
                                {programmes.map((p) => <option key={p.id} value={p.id}>{label2(p)}{p.status === 'hidden' ? ` (${t('catalogue_status_hidden')})` : ''}</option>)}
                            </select>
                        </div>
                    ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
                            {[['code', 'import_new_code', true], ['name_hu', 'import_new_name_hu', true], ['name_en', 'import_new_name_en', false], ['name_de', 'import_new_name_de', false]].map(([field, key, required]) => (
                                <div key={field}>
                                    <label htmlFor={`import-new-${field}`} style={label}>{t(key)}</label>
                                    <input id={`import-new-${field}`} value={draft[field]} onChange={setDraftField(field)} required={required} aria-required={required}
                                        maxLength={field === 'code' ? 20 : 200} style={input} />
                                </div>
                            ))}
                        </div>
                    )}

                    {check && (
                        <div role="group" aria-labelledby="import-lookalike-title" style={{ ...banner('warning'), marginTop: '12px' }}>
                            <h4 id="import-lookalike-title" style={{ margin: '0 0 8px' }}>{t('import_lookalike_title')}</h4>
                            {check.lookalikes.map((l) => (
                                <div key={l.id} style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '6px' }}>
                                    <span style={{ fontWeight: 'bold' }}>
                                        {t('import_lookalike_line', { programme: label2(l) })}
                                        {' '}({l.reasons.map((r) => t(`import_reason_${r}`)).join(', ')})
                                    </span>
                                    <button type="button" style={smallButton()} onClick={() => pickExisting(l)} aria-label={t('import_same_programme_label', { programme: label2(l) })}>{t('import_same_programme')}</button>
                                </div>
                            ))}
                            {check.codeTaken ? (
                                <p style={{ margin: '8px 0 0' }}>{t('import_code_taken', { code: check.programme.code })}</p>
                            ) : (
                                <div style={{ marginTop: '8px' }}>
                                    <button type="button" style={smallButton()} onClick={() => pickNew(check.programme, true)}>{t('import_different_programme')}</button>
                                    <span style={{ fontSize: '13px' }}>{t('import_different_hint', { code: check.programme.code })}</span>
                                </div>
                            )}
                        </div>
                    )}
                    {!check && <button type="submit" disabled={busy} style={{ ...primaryButton(busy), marginTop: '12px' }}>{t('import_continue')}</button>}
                </form>
            )}

            {/* Step 2: the file */}
            {chosen && (
                <>
                    <h3 style={stepTitle}>{t('import_step_file')}</h3>
                    <form onSubmit={runPreview} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', alignItems: 'end' }}>
                        <div>
                            <label htmlFor="import-file" style={label}>{t('import_file_label')}</label>
                            <input key={fileKey} id="import-file" type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files[0] || null); setPreview(null); setAnswers({}); }} style={input} />
                        </div>
                        <button type="submit" disabled={busy} style={primaryButton(busy)}>{t('import_preview_button')}</button>
                    </form>
                </>
            )}
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
            {notice && <p role="status" style={{ color: 'var(--success-text)', fontWeight: 'bold' }}>{notice}</p>}

            {/* Step 3: rows that don't match the chosen programme */}
            {preview && !preview.ready && (
                <div role="group" aria-labelledby="import-mismatch-title" style={{ marginTop: '15px', padding: '12px', border: '2px solid var(--cue-needs-info-border)', borderRadius: '6px', backgroundColor: 'var(--cue-needs-info-bg)', color: 'var(--cue-needs-info-text)' }}>
                    <h3 id="import-mismatch-title" style={{ margin: '0 0 6px' }}>{t('import_step_rows')}</h3>
                    <p style={{ margin: '0 0 10px', fontSize: '13px' }}>{t('import_mismatch_hint', { programme: label2(chosen.shown) })}</p>
                    {groups.map((g) => (
                        <div key={g.code} style={{ marginBottom: '10px', paddingBottom: '10px', borderBottom: '1px solid var(--cue-needs-info-border)' }}>
                            <p style={{ margin: '0 0 6px', fontWeight: 'bold' }}>{t('import_mismatch_line', { count: g.rows, rows: g.rowRanges, code: g.code, name: programmeName(g, i18n), chosen: chosen.shown.code })}</p>
                            {g.decision === 'same' ? (
                                <p style={{ margin: 0 }}>{t('import_mismatch_same_done', { code: g.code, chosen: chosen.shown.code })}</p>
                            ) : (
                                <>
                                    {g.owner && <p style={{ margin: '0 0 6px' }}>{t('import_mismatch_owner', { code: g.code, owner: label2(g.owner), chosen: chosen.shown.code })}</p>}
                                    {!g.owner && <button type="button" disabled={busy} style={smallButton()} onClick={() => treatAsSame(g.code)}>{t('import_mismatch_same')}</button>}
                                    <button type="button" disabled={busy} style={smallButton(true)} onClick={cancelImport}>{t('import_mismatch_cancel')}</button>
                                </>
                            )}
                        </div>
                    ))}
                    <p style={{ margin: 0, fontSize: '13px' }}>{t('import_nothing_saved')}</p>
                </div>
            )}

            {preview && preview.ready && (
                <div style={{ marginTop: '15px', padding: '12px', backgroundColor: 'var(--surface-2)', borderRadius: '6px' }}>
                    <p role="status" style={{ marginTop: 0, fontWeight: 'bold' }}>{t('import_preview_summary', { rows: preview.rows, valid: preview.validRows, errors: preview.errors.length, unchanged: preview.unchangedCourses })}</p>
                    <p style={{ marginTop: 0, color: 'var(--text-muted)' }}>{t('import_nothing_saved')}</p>

                    <List title={t('import_errors_title')} items={preview.errors} empty={t('import_none')}
                        render={(e) => <li key={`${e.row}-${e.code}`} style={{ color: 'var(--error-text)' }}>{t('import_error_row', { row: e.row, reason: t(`import_error_${e.code}`) })}</li>} />
                    {groups.length > 0 && (
                        <List title={t('import_aliases_title')} items={groups} empty={t('import_none')}
                            render={(g) => <li key={g.code}>{t('import_alias_line', { code: g.code, count: g.rows, chosen: chosen.shown.code })}</li>} />
                    )}
                    <List title={t('import_new_programmes')} items={preview.newProgrammes} empty={t('import_none')}
                        render={(p) => <li key={p.code}>{label2(p)}</li>} />
                    <List title={t('import_changed_programmes')} items={preview.changedProgrammes} empty={t('import_none')}
                        render={(p) => <li key={p.code}>{p.code}: {programmeName(p.before, i18n)} → {programmeName(p.after, i18n)}{p.before.status === 'hidden' ? ` (${t('import_shown_again')})` : ''}</li>} />
                    <List title={t('import_new_courses')} items={preview.newCourses} empty={t('import_none')}
                        render={(c) => <li key={c.course_code}>{c.course_code} – {c.course_name} ({c.credits})</li>} />
                    <List title={t('import_changed_courses')} items={preview.changedCourses} empty={t('import_none')}
                        render={(c) => (
                            <li key={c.id}>
                                {c.course_code}: {c.before.course_name} ({c.before.credits}) → {c.after.course_name} ({c.after.credits})
                                {c.before.status === 'hidden' ? ` (${t('import_shown_again')})` : ''}
                            </li>
                        )} />

                    <h4 style={{ margin: '16px 0 6px' }}>{t('import_missing_title')}</h4>
                    <p style={{ margin: '0 0 8px', fontSize: '13px', color: 'var(--text-muted)' }}>{t('import_missing_hint')}</p>
                    {preview.missingCourses.length === 0 ? <p style={{ margin: 0 }}>{t('import_none')}</p> : (
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead><tr><th style={th}>{t('import_missing_item')}</th><th style={th}>{t('import_missing_use')}</th><th style={th}>{t('import_decision_column')}</th></tr></thead>
                                <tbody>
                                    {preview.missingCourses.map((c) => (
                                        <tr key={`c-${c.id}`}>
                                            <td style={td}><strong>{t('import_course_label')}</strong> {c.course_code} – {c.course_name}</td>
                                            <td style={td}>{c.canDelete ? t('import_not_in_use') : reasonText(c.blockedBy)}</td>
                                            <td style={td}>{decisionSelect(String(c.id), c)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <div style={{ marginTop: '12px' }}>
                        <button type="button" onClick={() => setConfirming(true)} disabled={busy} style={primaryButton(busy)}>{t('import_confirm_button')}</button>
                        <button type="button" onClick={cancelImport} disabled={busy} style={{ ...smallButton(), padding: '9px 14px', marginLeft: '6px' }}>{t('import_mismatch_cancel')}</button>
                    </div>
                </div>
            )}
            {confirming && (
                <ConfirmModal title={t('confirm_title')} text={t('import_confirm', { programme: chosenText })} confirmLabel={t('import_confirm_button')}
                    busy={busy} onConfirm={confirm} onCancel={() => setConfirming(false)} />
            )}
        </section>
    );
};

export default CatalogueImport;
