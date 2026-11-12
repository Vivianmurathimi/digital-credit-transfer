import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage } from '../../errorMessage';
import Semesters from './Semesters';
import CatalogueImport from './CatalogueImport';
import Catalogue from './Catalogue';

// The Semester and Programmes & Courses sections of the admin menu (admin round Groups 4 and 5).
// Both need the semester list; a change reloads it (and the menu's badges, through onChange).

const useSemesters = () => {
    const { t } = useTranslation();
    const [semesters, setSemesters] = useState([]);
    // The timeline's numbers come from the server (utils/semesters.js), round 2 Group 1
    const [numbers, setNumbers] = useState({ reviewDaysDefault: null, reviewMarginDays: null, committeeDaysDefault: null });
    const [error, setError] = useState('');
    const load = useCallback(async () => {
        try {
            const data = await http.get('admin/semesters').json();
            setSemesters(data.semesters);
            setNumbers({ reviewDaysDefault: data.reviewDaysDefault, reviewMarginDays: data.reviewMarginDays, committeeDaysDefault: data.committeeDaysDefault });
            setError('');
        } catch (err) { setError(getErrorMessage(err, t, 'semesters_load_failed')); }
    }, [t]);
    useEffect(() => { load(); }, [load]);
    return { semesters, numbers, error, load };
};

const LoadError = ({ error }) => (error ? <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p> : null);

// Semester: create, edit, activate; the active one's Close now, Reopen until, last-days warning
export const SemesterSection = ({ onChange = () => {} }) => {
    const { semesters, numbers, error, load } = useSemesters();
    return (
        <>
            <LoadError error={error} />
            <Semesters semesters={semesters} reviewDaysDefault={numbers.reviewDaysDefault} reviewMarginDays={numbers.reviewMarginDays} committeeDaysDefault={numbers.committeeDaysDefault} onChange={() => { load(); onChange(); }} />
        </>
    );
};

// Programmes & Courses: the Neptun import and the Programmes & Courses page
export const CatalogueSection = ({ onChange = () => {} }) => {
    const { semesters, error, load } = useSemesters();
    const [reloadKey, setReloadKey] = useState(0);
    return (
        <>
            <LoadError error={error} />
            <CatalogueImport semesters={semesters} onImported={() => { load(); setReloadKey((k) => k + 1); onChange(); }} />
            <Catalogue semesters={semesters} reloadKey={reloadKey} onChange={onChange} />
        </>
    );
};
