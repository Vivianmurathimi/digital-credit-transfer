import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage } from '../../errorMessage';
import { startActing } from '../../acting';
import { card } from './adminStyles';

// Act as a student or a reviewer (admin round Group 1; in the Students and Reviewers sections of
// the admin menu since Group 5). The server starts and records the session; everything done in it
// is saved as Admin. Removed reviewers are greyed out (nobody can act as them).
// onActingStarted: called once the session is the person's (the dashboard then shows their screen)
const ActAs = ({ role, onActingStarted }) => {
    const { t } = useTranslation();
    const [people, setPeople] = useState([]);
    const [search, setSearch] = useState('');
    const [open, setOpen] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        http.get('users').json()
            .then((data) => setPeople((data.users || []).filter((u) => u.role === role)))
            .catch((err) => setError(getErrorMessage(err, t, 'acting_start_failed')));
    }, [role, t]);

    const actAs = async (person) => {
        if (person.deactivated) return;
        setError('');
        try {
            await startActing(person.id);
            onActingStarted();
        } catch (err) { setError(getErrorMessage(err, t, 'acting_start_failed')); }
    };

    const q = search.toLowerCase();
    const found = people.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    const isStudent = role === 'student';

    return (
        <section aria-labelledby={`act-as-${role}`} style={{ ...card, backgroundColor: 'var(--surface-2)', border: '3px dashed var(--link)' }}>
            <h2 id={`act-as-${role}`} style={{ marginTop: 0, color: 'var(--link)' }}>{t(isStudent ? 'superadmin_act_as_student' : 'superadmin_act_as_reviewer')}</h2>
            <p style={{ fontSize: '14px', color: 'var(--text-muted)' }}>{t('superadmin_act_as_description')}</p>
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
            <div style={{ position: 'relative', maxWidth: '320px' }}>
                <input
                    type="text" aria-label={t(isStudent ? 'superadmin_act_as_student' : 'superadmin_act_as_reviewer')}
                    placeholder={t('superadmin_search_placeholder')} value={search}
                    onChange={(e) => setSearch(e.target.value)} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)}
                    style={{ width: '100%', padding: '10px', border: '1px solid var(--link)', borderRadius: '5px', boxSizing: 'border-box', fontSize: '14px' }}
                />
                {open && (
                    <div style={{ position: 'absolute', top: '44px', left: 0, right: 0, maxHeight: '220px', overflowY: 'auto', backgroundColor: 'var(--surface)', border: '1px solid var(--link)', borderRadius: '5px', zIndex: 1000, boxShadow: '0 4px 8px rgba(0,0,0,0.1)' }}>
                        {found.length === 0 ? <div style={{ padding: '10px', color: 'var(--danger-accent)', fontSize: '13px', textAlign: 'center' }}>{t(isStudent ? 'superadmin_no_students' : 'superadmin_no_reviewers')}</div> : found.map((person) => (
                            <div
                                key={person.id} role="button" tabIndex={0} onClick={() => actAs(person)} onKeyDown={(e) => { if (e.key === 'Enter') actAs(person); }}
                                aria-disabled={person.deactivated || undefined}
                                style={{ padding: '10px', cursor: person.deactivated ? 'not-allowed' : 'pointer', opacity: person.deactivated ? 0.55 : 1, borderBottom: '1px solid var(--border-subtle)' }}
                            >
                                <div style={{ fontWeight: 'bold', color: 'var(--link)', fontSize: '14px' }}>{person.name}{person.deactivated && ` (${t('superadmin_removed_reviewer')})`}</div>
                                <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{person.email}</div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
};

export default ActAs;
