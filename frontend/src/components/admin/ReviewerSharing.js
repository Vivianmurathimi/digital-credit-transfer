import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage } from '../../errorMessage';
import { formatDate } from '../../dates';
import { programmeName } from '../../programmeName';
import StatusChip from '../StatusChip';
import { card, input, label, smallButton, td, th, disabledButton } from './adminStyles';

// Sharing work between reviewers (round 2 Group 1 Part C), per programme. All optional: an
// application nobody is assigned to is shared, and everyone who can see the programme may decide it.
//   - extra reviewers: "allowed to assist" on or off (off: their assigned open applications become shared)
//   - the open applications: tick some, assign them to a reviewer who can see the programme, or unassign
//   - "Distribute evenly": the unassigned pending applications across the ticked reviewers
// The server checks every rule (routes/adminSharing.js); this only shows what it allows.
// version / onChange: the staff list above and this panel reload each other after a change.

const ReviewerSharing = ({ version = 0, onChange = () => {} }) => {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const [programmes, setProgrammes] = useState([]);
    const [code, setCode] = useState('');
    const [data, setData] = useState(null); // { programme, reviewers, applications }
    const [selected, setSelected] = useState([]); // application ids
    const [assignTo, setAssignTo] = useState('');
    const [ticked, setTicked] = useState([]); // reviewer ids for "Distribute evenly"
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        http.get('programmes').json().then((result) => setProgrammes(result.programmes || [])).catch(() => setProgrammes([]));
    }, []);

    const load = useCallback(async () => {
        if (!code) { setData(null); return; }
        try {
            setData(await http.get(`admin/sharing/${encodeURIComponent(code)}`).json());
            setError('');
        } catch (err) { setError(getErrorMessage(err, t, 'sharing_load_failed')); }
    }, [code, t]);
    useEffect(() => { load(); }, [load, version]);
    useEffect(() => { setSelected([]); setTicked([]); setAssignTo(''); setNotice(''); }, [code]);

    // One change, then reload this panel and tell the staff list
    const run = async (request, noticeText) => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
            const result = await request();
            setNotice(noticeText(result));
            setSelected([]);
        } catch (err) {
            setError(getErrorMessage(err, t, 'sharing_action_failed'));
        } finally {
            setBusy(false);
            await load();
            onChange();
        }
    };

    const base = `admin/sharing/${encodeURIComponent(code)}`;
    const reviewers = data?.reviewers || [];
    const seeing = reviewers.filter((r) => r.sees);
    const applications = data?.applications || [];
    const unassignedPending = applications.filter((a) => a.status === 'pending' && a.assigned_reviewer_id == null).length;
    const toggle = (list, setList, id) => setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
    const roleText = (r) => (r.role === 'main' ? t('staff_link_role_main') : `${t('staff_link_role_extra')}, ${t(r.can_assist ? 'staff_link_assisting' : 'staff_link_standby')}`);

    const setAssist = (reviewer, canAssist) => {
        if (!canAssist && !window.confirm(t('sharing_confirm_standby', { name: reviewer.name, count: reviewer.assigned_open }))) return;
        run(() => http.put(`${base}/assist/${reviewer.id}`, { json: { can_assist: canAssist } }).json(),
            (r) => t(canAssist ? 'sharing_assist_on_done' : 'sharing_assist_off_done', { name: reviewer.name, count: r.unassigned }));
    };
    const assign = (reviewerId) => run(
        () => http.post(`${base}/assign`, { json: { application_ids: selected, reviewer_id: reviewerId } }).json(),
        (r) => (reviewerId === null ? t('sharing_unassigned_done', { count: r.changed })
            : t('sharing_assigned_done', { count: r.changed, name: reviewers.find((x) => x.id === reviewerId)?.name || '' })),
    );
    const distribute = () => run(
        () => http.post(`${base}/distribute`, { json: { reviewer_ids: ticked } }).json(),
        (r) => t('sharing_distributed_done', { count: r.distributed, people: ticked.length }),
    );

    return (
        <section aria-labelledby="sharing-title" style={card}>
            <h2 id="sharing-title" style={{ marginTop: 0, color: 'var(--heading)' }}>{t('sharing_title')}</h2>
            <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{t('sharing_intro')}</p>
            <div style={{ maxWidth: '360px' }}>
                <label htmlFor="sharing-programme" style={label}>{t('staff_programme_label')}</label>
                <select id="sharing-programme" value={code} onChange={(e) => setCode(e.target.value)} style={input}>
                    <option value="">{t('staff_programme_choose')}</option>
                    {programmes.map((p) => <option key={p.code} value={p.code}>{programmeName(p, i18n)}</option>)}
                </select>
            </div>
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
            {notice && <p role="status" style={{ color: 'var(--success-text)', fontWeight: 'bold' }}>{notice}</p>}

            {data && (
                <>
                    <h3 style={{ marginBottom: '6px' }}>{t('sharing_reviewers_title')}</h3>
                    {reviewers.length === 0 ? <p style={{ color: 'var(--text-muted)' }}>{t('sharing_no_reviewers')}</p> : (
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr>
                                        <th style={th}>{t('sharing_distribute_column')}</th>
                                        <th style={th}>{t('staff_name_column')}</th>
                                        <th style={th}>{t('staff_link_role_label')}</th>
                                        <th style={th}>{t('sharing_assigned_column')}</th>
                                        <th style={th}>{t('staff_actions_column')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {reviewers.map((r) => (
                                        <tr key={r.id}>
                                            <td style={td}>
                                                <input type="checkbox" disabled={!r.sees} checked={ticked.includes(r.id)} onChange={() => toggle(ticked, setTicked, r.id)}
                                                    aria-label={t('sharing_tick_reviewer', { name: r.name })} />
                                            </td>
                                            <td style={td}>{r.name}</td>
                                            <td style={td}>{roleText(r)}</td>
                                            <td style={td}>{r.assigned_open}</td>
                                            <td style={td}>
                                                {r.role === 'extra' && (
                                                    <button type="button" disabled={busy} style={{ ...smallButton(r.can_assist), ...(busy ? disabledButton : {}) }} onClick={() => setAssist(r, !r.can_assist)}>
                                                        {t(r.can_assist ? 'sharing_assist_off' : 'sharing_assist_on')}
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', marginTop: '10px' }}>
                        <button type="button" disabled={busy || ticked.length === 0 || unassignedPending === 0} onClick={distribute}
                            style={{ ...smallButton(), ...(busy || ticked.length === 0 || unassignedPending === 0 ? disabledButton : {}) }}>
                            {t('sharing_distribute_button', { count: unassignedPending })}
                        </button>
                        <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{t('sharing_distribute_hint')}</span>
                    </div>

                    <h3 style={{ marginBottom: '6px' }}>{t('sharing_applications_title')}</h3>
                    {applications.length === 0 ? <p style={{ color: 'var(--text-muted)' }}>{t('sharing_no_applications')}</p> : (
                        <>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
                                <label htmlFor="sharing-assign-to">{t('sharing_assign_to_label', { count: selected.length })}</label>
                                <select id="sharing-assign-to" value={assignTo} onChange={(e) => setAssignTo(e.target.value)} style={{ padding: '6px' }}>
                                    <option value="">{t('sharing_choose_reviewer')}</option>
                                    {seeing.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                                </select>
                                <button type="button" disabled={busy || selected.length === 0 || !assignTo} onClick={() => assign(Number(assignTo))}
                                    style={{ ...smallButton(), ...(busy || selected.length === 0 || !assignTo ? disabledButton : {}) }}>
                                    {t('sharing_assign_button')}
                                </button>
                                <button type="button" disabled={busy || selected.length === 0} onClick={() => assign(null)}
                                    style={{ ...smallButton(), ...(busy || selected.length === 0 ? disabledButton : {}) }}>
                                    {t('sharing_unassign_button')}
                                </button>
                            </div>
                            <div style={{ overflowX: 'auto' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr>
                                            <th style={th}>
                                                <input type="checkbox" aria-label={t('sharing_select_all')} checked={selected.length === applications.length}
                                                    onChange={() => setSelected(selected.length === applications.length ? [] : applications.map((a) => a.id))} />
                                            </th>
                                            <th style={th}>{t('catalogue_course_column')}</th>
                                            <th style={th}>{t('sharing_student_column')}</th>
                                            <th style={th}>{t('staff_status_column')}</th>
                                            <th style={th}>{t('sharing_submitted_column')}</th>
                                            <th style={th}>{t('sharing_assigned_to_column')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {applications.map((a) => (
                                            <tr key={a.id}>
                                                <td style={td}>
                                                    <input type="checkbox" checked={selected.includes(a.id)} onChange={() => toggle(selected, setSelected, a.id)}
                                                        aria-label={t('sharing_select_application', { course: a.target_course_code, student: a.student_name })} />
                                                </td>
                                                <td style={td}>{a.target_course_code}{a.course_name ? ` – ${a.course_name}` : ''}</td>
                                                <td style={td}>{a.student_name}{a.neptun_code ? ` · ${a.neptun_code}` : ''}</td>
                                                <td style={td}><StatusChip status={a.status}>{t(`status_${a.status}`)}</StatusChip></td>
                                                <td style={td}>{formatDate(a.submitted_at, language)}</td>
                                                <td style={td}>{a.assigned_name || t('sharing_shared')}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    )}
                </>
            )}
        </section>
    );
};

export default ReviewerSharing;
