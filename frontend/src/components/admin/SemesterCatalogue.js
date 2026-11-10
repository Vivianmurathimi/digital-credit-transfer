import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../../http';
import { getErrorMessage } from '../../errorMessage';
import Semesters from './Semesters';
import CatalogueImport from './CatalogueImport';
import Catalogue from './Catalogue';

// Semesters, the Neptun import and Programmes & Courses (admin round Group 4), sharing one
// semester list: a change in one part reloads the others.
const SemesterCatalogue = () => {
    const { t } = useTranslation();
    const [semesters, setSemesters] = useState([]);
    const [error, setError] = useState('');
    const [reloadKey, setReloadKey] = useState(0);

    const load = useCallback(async () => {
        try {
            setSemesters((await http.get('admin/semesters').json()).semesters);
            setError('');
        } catch (err) { setError(getErrorMessage(err, t, 'semesters_load_failed')); }
    }, [t]);
    useEffect(() => { load(); }, [load]);
    const changed = () => { load(); setReloadKey((k) => k + 1); };

    return (
        <>
            {error && <p role="alert" style={{ color: 'var(--error-text)' }}>{error}</p>}
            <Semesters semesters={semesters} onChange={changed} />
            <CatalogueImport semesters={semesters} onImported={changed} />
            <Catalogue semesters={semesters} reloadKey={reloadKey} />
        </>
    );
};

export default SemesterCatalogue;
