import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import downloadPdf from '../downloadPdf';
import { getErrorMessage, unpackBlobError } from '../errorMessage';

// "Download PDF" of one of the student's own applications (fixes 4a): the server makes it with only
// what the student may see (GET /api/applications/mine/:id/pdf), saved as application-<id>.pdf.
// course: for the accessible name ("Download PDF of …"); large: the detail dialog's size.
const StudentPdfButton = ({ applicationId, course = '', large = false }) => {
    const { t } = useTranslation();
    const [state, setState] = useState(''); // '' | 'working' | an error text
    const save = async () => {
        setState('working');
        try {
            await downloadPdf(`applications/mine/${applicationId}/pdf`, `application-${applicationId}.pdf`);
            setState('');
        } catch (err) { setState(getErrorMessage(await unpackBlobError(err), t, 'pdf_download_failed')); }
    };
    return (
        <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
            <button
                type="button" onClick={save} disabled={state === 'working'}
                aria-label={course ? t('student_pdf_download_label', { course }) : undefined}
                style={{ padding: large ? '10px 15px' : '6px 12px', backgroundColor: 'var(--surface)', color: 'var(--link)', border: '1px solid var(--link)', borderRadius: large ? '5px' : '4px', cursor: state === 'working' ? 'wait' : 'pointer', fontWeight: 'bold' }}
            >
                {state === 'working' ? t('pdf_working') : t('student_pdf_download')}
            </button>
            {state && state !== 'working' && <span role="alert" style={{ color: 'var(--error-text)', fontSize: '13px' }}>{state}</span>}
        </span>
    );
};

export default StudentPdfButton;
