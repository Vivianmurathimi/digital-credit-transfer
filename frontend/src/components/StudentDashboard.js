import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import http from '../http';
import { useTranslation } from 'react-i18next';
import { getErrorCode, getErrorMessage } from '../errorMessage';
import SecureImage from './SecureImage';
import { getUploadEndpoint, openSecureFile } from '../secureFiles';
import * as pdfjsLib from 'pdfjs-dist';
import { CREDIT_SYSTEMS, newInstitution, newCourseRow, allEcts, rowHasContent, rowsUsingInstitution, removeInstitution, countryOptions, buildSubmission } from '../applicationForm';

// Set up the worker for PDF.js to handle conversions
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const fieldLabelStyle = { fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '3px' };
const fieldInputStyle = { width: '100%', padding: '8px', boxSizing: 'border-box' };

const StudentDashboard = ({ userId, isImpersonating = false }) => {
    const { t, i18n } = useTranslation();
    const [courses, setCourses] = useState([]);
    const [coursesLoaded, setCoursesLoaded] = useState(false);
    const [studentTab, setStudentTab] = useState('dashboard');
    
    // --- PHASE 1: Previous institutions and the courses completed there ---
    // Each institution has a stable internal key; course rows point to it by that key
    // (turned into a position only when submitting, see applicationForm.js)
    const [institutions, setInstitutions] = useState(() => [newInstitution()]);
    const [fulfilledCourses, setFulfilledCourses] = useState(() => [newCourseRow()]);
    const [countryCodes, setCountryCodes] = useState([]);
    // Positions -> keys/ids of the last submit, to place server errors under the right field
    const lastSubmitMap = useRef(null);
    // Grading-document upload state per institution key: { uploading: true } or { message: '…' }
    const [gradingStatus, setGradingStatus] = useState({});
    // The current institutions, for uploads that finish after the list has changed
    const institutionsRef = useRef(institutions);
    institutionsRef.current = institutions;
    // Hidden file inputs of the grading documents, opened by their translated buttons
    const gradingInputs = useRef({});
    // Same for course rows (an evidence upload can finish after its row was removed)
    const rowsRef = useRef(fulfilledCourses);
    rowsRef.current = fulfilledCourses;
    // A message per course row, e.g. when its evidence could not be deleted: { [rowId]: '…' }
    const [rowMessages, setRowMessages] = useState({});
    const [selectedCourses, setSelectedCourses] = useState([]); 
    
    // --- PHASE 2: Student Cover Letter ---
    const [studentNote, setStudentNote] = useState('');
    
    // --- INLINE UPLOAD STATE ---
    const [activeUploadId, setActiveUploadId] = useState(null); 
    const [previewUrl, setPreviewUrl] = useState(null);
    const [rawFile, setRawFile] = useState(null); 
    const [uploadStatus, setUploadStatus] = useState('');
    const [submitStatus, setSubmitStatus] = useState('');
    
    // --- PHASE 3: Dashboard & Resubmit State ---
    const [myApplications, setMyApplications] = useState([]); 
    const [resubmitModal, setResubmitModal] = useState({ isOpen: false, app: null });
    const [resubmitFiles, setResubmitFiles] = useState([]);
    const [resubmitNote, setResubmitNote] = useState(''); 
    const [resubmitPreviewUrl, setResubmitPreviewUrl] = useState(null); 
    const [resubmitRawFile, setResubmitRawFile] = useState(null); 
    const [isNoteExpanded, setIsNoteExpanded] = useState(false);
    
    const [evidenceRequiredMsg, setEvidenceRequiredMsg] = useState('');
    const [matches, setMatches] = useState({ credits: false });
    const [isSubmissionsOpen, setIsSubmissionsOpen] = useState(true);

    const imgRef = useRef(null);    
    const canvasRef = useRef(null); 
    const [ctx, setCtx] = useState(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [activeTool, setActiveTool] = useState('pen'); 

    // Returns the loaded list (or null), so a failed submit can compare against it
    const fetchCourses = useCallback(async () => {
        try {
            const data = await http.get('pte-courses').json();
            if (data.success) {
                setCourses(data.courses);
                setCoursesLoaded(true);
                return data.courses;
            }
        } catch (err) { console.error(err); }
        return null;
    }, []);

    const fetchMyApplications = useCallback(async () => {
        if (!userId) return;
        try {
            // A student reads "my applications" (id from the login token);
            // the superadmin impersonating a student reads that student's list by id
            const data = await http.get(isImpersonating ? `applications/student/${userId}` : 'applications/mine').json();
            if (data.success) setMyApplications(data.applications);
        } catch (err) { console.error('Error fetching student apps', err); }
    }, [userId, isImpersonating]);

    const fetchSystemStatus = useCallback(async () => {
        try {
            const data = await http.get('settings/status').json();
            if (data.success) setIsSubmissionsOpen(data.isOpen);
        } catch (err) {
            console.error('Error fetching system status', err);
        }
    }, []);

    useEffect(() => {
        fetchCourses();
        fetchMyApplications();
        fetchSystemStatus();
    }, [fetchCourses, fetchMyApplications, fetchSystemStatus]);

    // Country codes from the server; the names come from the browser in the current language
    useEffect(() => {
        http.get('countries').json()
            .then((data) => setCountryCodes(data.countries || []))
            .catch((err) => console.error('Could not load countries', err));
    }, []);

    const language = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2);
    const countries = useMemo(() => countryOptions(countryCodes, language), [countryCodes, language]);
    const countryName = (code) => countries.find((c) => c.code === code)?.name || code;
    // "TU Berlin (Germany)", so institutions with the same name can be told apart
    const institutionLabel = (inst, index) => {
        const name = inst.name.trim() || t('student_institution_unnamed', { n: index + 1 });
        return inst.country ? `${name} (${countryName(inst.country)})` : name;
    };

    // Validation & Credit Math
    useEffect(() => {
        if (selectedCourses.length > 0 && fulfilledCourses[0].course_name) {
            // Different credit systems can't be added up: no comparison, the reviewer judges
            if (!allEcts(fulfilledCourses)) {
                setMatches({ credits: false });
                // While a row has no credit system yet, say nothing about comparing credits
                const undecided = fulfilledCourses.some(c => !c.credit_system);
                setEvidenceRequiredMsg(selectedCourses.length > 1
                    ? t('student_evidence_notice', { reason: t('student_evidence_reason_package') })
                    : (undecided ? '' : t('student_credits_compare_skipped')));
                return;
            }
            const totalTargetCredits = selectedCourses.reduce((sum, c) => sum + parseFloat(c.credits || 0), 0);
            const totalInputCredits = fulfilledCourses.reduce((sum, c) => sum + parseFloat(c.credits || 0), 0);
            
            const creditMatch = totalInputCredits >= totalTargetCredits;
            setMatches({ credits: creditMatch });

            if (!creditMatch || selectedCourses.length > 1) {
                const reasonKey = selectedCourses.length > 1
                    ? 'student_evidence_reason_package'
                    : 'student_evidence_reason_credit_gap';
                setEvidenceRequiredMsg(t('student_evidence_notice', { reason: t(reasonKey) }));
            } else {
                setEvidenceRequiredMsg('');
            }
        } else {
            setMatches({ credits: false });
            setEvidenceRequiredMsg('');
        }
    }, [fulfilledCourses, selectedCourses, t]);

    const parseCourses = (jsonStringOrArray) => {
        if (!jsonStringOrArray) return [];
        if (Array.isArray(jsonStringOrArray)) return jsonStringOrArray;
        try { return JSON.parse(jsonStringOrArray); } catch (e) { return []; }
    };

    // Row Management
    const handleAddCourseRow = () => setFulfilledCourses([...fulfilledCourses, newCourseRow()]);
    // Removing a row also deletes its evidence from storage. At least one row always stays.
    // Rows with content are confirmed first; if the evidence can't be deleted, the row stays.
    const handleRemoveCourseRow = async (id) => {
        const row = fulfilledCourses.find(c => c.id === id);
        if (!row || fulfilledCourses.length <= 1) return;
        if (rowHasContent(row) && !window.confirm(t(row.file ? 'student_remove_course_confirm_file' : 'student_remove_course_confirm'))) return;
        if (row.file) {
            try {
                await http.delete(getUploadEndpoint(row.file));
            } catch (err) {
                console.error('Could not delete evidence', err);
                setRowMessages(prev => ({ ...prev, [id]: t('student_evidence_remove_failed') }));
                return;
            }
        }
        setFulfilledCourses(list => list.filter(c => c.id !== id));
        setRowMessages(prev => { const next = { ...prev }; delete next[id]; return next; });
        if (activeUploadId === id) { setActiveUploadId(null); setPreviewUrl(null); setRawFile(null); }
    };
    const handleCourseChange = (id, field, value) => setFulfilledCourses(fulfilledCourses.map(c => c.id === id ? { ...c, [field]: value } : c));

    // Institutions
    const handleAddInstitution = () => setInstitutions([...institutions, newInstitution()]);
    const handleInstitutionChange = (key, field, value) => setInstitutions(institutions.map(i => i.key === key ? { ...i, [field]: value } : i));
    const setGradingState = (key, state) => setGradingStatus((prev) => ({ ...prev, [key]: state }));

    const handleRemoveInstitution = async (key) => {
        // Ask first if courses use it: their institution choice would be cleared
        const used = rowsUsingInstitution(fulfilledCourses, key);
        if (used > 0 && !window.confirm(t('student_remove_institution_confirm', { count: used }))) return;

        // Its grading document is deleted from storage too. If that fails, the institution stays,
        // so no file is left behind unnoticed.
        const file = institutions.find((i) => i.key === key)?.grading_file;
        if (file) {
            try {
                await http.delete(getUploadEndpoint(file));
            } catch (err) {
                console.error('Could not delete grading document', err);
                setGradingState(key, { message: t('student_grading_doc_remove_failed') });
                return;
            }
        }
        const next = removeInstitution(institutionsRef.current, fulfilledCourses, key);
        setInstitutions(next.institutions);
        setFulfilledCourses(next.rows);
    };

    // Grading-system document: uploaded as soon as it is chosen (no highlighter).
    // Replacing uploads the new file first and deletes the old one only after that worked.
    const handleGradingFileChosen = async (key, file) => {
        if (!file) return;
        setGradingState(key, { uploading: true });
        try {
            const formData = new FormData();
            formData.append('file', file);
            const data = await http.post('uploads', { body: formData, timeout: false }).json();
            const current = institutionsRef.current.find((i) => i.key === key);
            if (!current) {
                // The institution was removed while uploading: don't leave the new file behind
                http.delete(getUploadEndpoint(data.fileName)).catch((err) => console.error('Could not delete unused upload', err));
                return;
            }
            const previous = current.grading_file;
            setInstitutions((list) => list.map((i) => (i.key === key ? { ...i, grading_file: data.fileName } : i)));
            setGradingState(key, {});
            if (previous) {
                http.delete(getUploadEndpoint(previous)).catch((err) => console.error('Could not delete replaced grading document', err));
            }
        } catch (err) {
            setGradingState(key, { message: getErrorMessage(err, t, 'student_upload_failed') });
        }
    };

    const handleRemoveGradingFile = async (key, file) => {
        try {
            await http.delete(getUploadEndpoint(file));
            setInstitutions((list) => list.map((i) => (i.key === key ? { ...i, grading_file: null } : i)));
            setGradingState(key, {});
        } catch (err) {
            setGradingState(key, { message: getErrorMessage(err, t, 'file_remove_failed') });
        }
    };
    
    // Evidence files need the login token, so they are opened through openSecureFile
    const handleOpenFile = (e, fileName) => {
        e.preventDefault();
        openSecureFile(fileName).catch((err) => alert(getErrorMessage(err, t, 'file_open_failed')));
    };
    const isImageFile = (fileName) => !!fileName && /\.(jpe?g|png|gif|bmp|webp)$/i.test(fileName);
    
    const clearUploadSelection = (isResubmit = false) => {
        if (isResubmit) {
            setResubmitPreviewUrl(null);
            setResubmitRawFile(null);
        } else {
            setPreviewUrl(null);
            setRawFile(null);
        }
    };

    // Delete logic specifically tied to the exact course case
    const handleDeleteUploadedFile = async (courseId, fileName) => {
        if (!fileName) return;
        try {
            await http.delete(getUploadEndpoint(fileName));
            // Only removes the file from the specific course row
            setFulfilledCourses(fulfilledCourses.map(c => c.id === courseId ? { ...c, file: null } : c));
            if (activeUploadId === courseId) setActiveUploadId(null);
        } catch (err) {
            console.error('Delete upload error', err);
            alert(getErrorMessage(err, t, 'file_remove_failed'));
        }
    };

    // Delete a file specifically from the Resubmit Modal
    const handleDeleteResubmitFile = async (fileName) => {
        if (!fileName) return;
        try {
            await http.delete(getUploadEndpoint(fileName));
            // Remove the file from the resubmit array so it disappears from the UI
            setResubmitFiles(prev => prev.filter(f => f !== fileName));
        } catch (err) {
            console.error('Delete resubmit upload error', err);
            alert(getErrorMessage(err, t, 'file_remove_failed'));
        }
    };

    // Toggle Uploader for a specific case
    const triggerUploadForCourse = (id) => { 
        if (activeUploadId === id) {
            setActiveUploadId(null); 
        } else {
            setActiveUploadId(id); 
            setPreviewUrl(null); 
            setRawFile(null); 
        }
    };

    // --- SMART FILE HANDLER (Handles Images & Converts PDFs) ---
    const handleFileSelect = async (e, isResubmit = false) => {
        const file = e.target.files[0];
        if (!file) return;

        if (file.type.startsWith('image/')) {
            if (isResubmit) {
                setResubmitRawFile(null);
                setResubmitPreviewUrl(URL.createObjectURL(file));
            } else {
                setRawFile(null);
                setPreviewUrl(URL.createObjectURL(file));
            }
        } else if (file.type === 'application/pdf') {
            const reader = new FileReader();
            reader.onload = async function() {
                try {
                    const typedarray = new Uint8Array(this.result);
                    const pdf = await pdfjsLib.getDocument(typedarray).promise;
                    const page = await pdf.getPage(1); 
                    const viewport = page.getViewport({ scale: 1.5 }); 
                    
                    const tempCanvas = document.createElement('canvas');
                    const context = tempCanvas.getContext('2d');
                    tempCanvas.height = viewport.height;
                    tempCanvas.width = viewport.width;
                    
                    await page.render({ canvasContext: context, viewport: viewport }).promise;
                    const pdfAsImageUrl = tempCanvas.toDataURL('image/png');
                    
                    if (isResubmit) {
                        setResubmitRawFile(null);
                        setResubmitPreviewUrl(pdfAsImageUrl);
                    } else {
                        setRawFile(null);
                        setPreviewUrl(pdfAsImageUrl);
                    }
                } catch (err) {
                    console.error("Error rendering PDF:", err);
                    alert("Could not load this PDF for highlighting. You can still attach it as a raw document.");
                    if (isResubmit) setResubmitRawFile(file);
                    else setRawFile(file);
                }
            };
            reader.readAsArrayBuffer(file);
        } else {
            if (isResubmit) {
                setResubmitPreviewUrl(null);
                setResubmitRawFile(file);
            } else {
                setPreviewUrl(null);
                setRawFile(file);
            }
        }
    };

    // --- YOUR EXACT CANVAS LOGIC --- 
    const handleImageLoad = () => {
        if (imgRef.current && canvasRef.current) {
            const canvas = canvasRef.current;
            canvas.width = imgRef.current.clientWidth; 
            canvas.height = imgRef.current.clientHeight;
            setCtx(canvas.getContext('2d'));
        }
    };

    const handleClearCanvas = () => { 
        if (canvasRef.current && ctx) {
            ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height); 
        }
    };

    const handleUploadHighlighted = (isResubmit = false) => {
        if (!canvasRef.current || !imgRef.current) return;
        setUploadStatus(t('student_upload_saving'));
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvasRef.current.width; 
        tempCanvas.height = canvasRef.current.height;
        const tempCtx = tempCanvas.getContext('2d');
        
        tempCtx.drawImage(imgRef.current, 0, 0, tempCanvas.width, tempCanvas.height);
        tempCtx.drawImage(canvasRef.current, 0, 0);
        
        tempCanvas.toBlob(async (blob) => {
            const formData = new FormData(); 
            formData.append('file', blob, `marked-${Date.now()}.png`);
            // We use executeUpload here so it knows WHICH course to attach it to!
            executeUpload(formData, isResubmit);
        }, 'image/png'); 
    };

    const handleStandardUpload = (isResubmit = false) => {
        const fileToUpload = isResubmit ? resubmitRawFile : rawFile;
        if (!fileToUpload) return;
        setUploadStatus(t('student_upload_saving'));
        const formData = new FormData();
        formData.append('file', fileToUpload);
        executeUpload(formData, isResubmit);
    };

    // Handles the actual API call and state update for the specific course
    const executeUpload = async (formData, isResubmit) => {
        // The row is fixed when the upload starts, so switching rows meanwhile can't misplace the file
        const targetRowId = activeUploadId;
        try {
            // FormData as body: the browser sets the multipart Content-Type itself.
            // No time limit, so a big file on a slow connection is not cut off.
            const data = await http.post('uploads', { body: formData, timeout: false }).json();
            if (data.success) {
                if (isResubmit) {
                    setResubmitFiles(prev => [...prev, data.fileName]);
                    setResubmitPreviewUrl(null); 
                    setResubmitRawFile(null);
                } else {
                    // The row was removed while uploading: don't leave the new file behind
                    if (!rowsRef.current.some(c => c.id === targetRowId)) {
                        http.delete(getUploadEndpoint(data.fileName)).catch((err) => console.error('Could not delete unused upload', err));
                        return;
                    }
                    setFulfilledCourses(list => list.map(c => c.id === targetRowId ? { ...c, file: data.fileName } : c));
                    setTimeout(() => { setPreviewUrl(null); setRawFile(null); setActiveUploadId(null); }, 1000);
                }
                setUploadStatus(t('student_upload_saved'));
                setTimeout(() => setUploadStatus(''), 2000);
            }
        } catch (err) { setUploadStatus(getErrorMessage(err, t, 'student_upload_failed')); }
    }

    // The programme has no target courses yet (e.g. before the admin imports them): nothing to apply for
    const noCourses = coursesLoaded && courses.length === 0;
    const canSubmit = isSubmissionsOpen && !noCourses;

    const handleSubmitApplication = async () => {
        if (!isSubmissionsOpen) return setSubmitStatus(t('student_submissions_closed', 'Submissions are currently closed.'));
        if (noCourses) return setSubmitStatus(t('student_no_courses_for_programme'));

        const isValid = fulfilledCourses.every(c => c.course_name.trim() !== '' && c.file !== null);
        if (!isValid || selectedCourses.length === 0) return setSubmitStatus(t('student_submit_complete_fields'));

        try {
            setSubmitStatus(t('student_submit_saving'));
            // Only the course ids: the server checks them against the student's programme
            // and stores their code, name and credits itself
            // Institution keys -> positions, credits -> numbers (see applicationForm.js)
            const { institutionKeyAt, rowIdAt, ...form } = buildSubmission(institutions, fulfilledCourses);
            lastSubmitMap.current = { institutionKeyAt, rowIdAt };
            const data = await http.post('applications', { json: {
                ...form,
                target_course_ids: selectedCourses.map(c => c.id),
                system_note: evidenceRequiredMsg,
                student_note: studentNote 
            } }).json();
            
            if (data.success) {
                alert(t('student_submission_success'));
                setInstitutions([newInstitution()]);
                setFulfilledCourses([newCourseRow()]);
                setGradingStatus({});
                setRowMessages({});
                setSelectedCourses([]); setActiveUploadId(null); setPreviewUrl(null); setSubmitStatus(''); setStudentNote('');
                fetchMyApplications(); 
                setStudentTab('dashboard');
            }
        } catch (err) {
            const message = getErrorMessage(err, t, 'student_submission_failed');
            if (getErrorCode(err) !== 'COURSE_NOT_IN_PROGRAMME') return setSubmitStatus(message);

            // The course list changed since the page loaded (e.g. a new import): reload it,
            // keep the chosen courses that still exist and say which ones were removed
            const fresh = await fetchCourses();
            if (!fresh) return setSubmitStatus(message);
            const freshIds = new Set(fresh.map(c => c.id));
            const removed = selectedCourses.filter(c => !freshIds.has(c.id));
            setSelectedCourses(selectedCourses.filter(c => freshIds.has(c.id)));
            setSubmitStatus(removed.length
                ? `${message} ${t('student_courses_removed', { courses: removed.map(c => c.course_code).join(', ') })}`
                : message);
        }
    };

    const submitResubmission = async () => {
        if (!isSubmissionsOpen) return alert(t('student_submissions_closed', 'Submissions are currently closed.'));
        if (resubmitFiles.length === 0 && resubmitNote.trim() === '') return alert(t('student_resubmit_missing_info_alert'));
        try {
            setUploadStatus(t('student_resubmission_sending'));
            const data = await http.put(`applications/${resubmitModal.app.id}/resubmit`, { json: { 
                student_resubmit_note: resubmitNote,
                new_files: resubmitFiles.join(',') 
            } }).json();
            if (data.success) {
                alert(t('student_resubmission_success'));
                setResubmitModal({ isOpen: false, app: null }); setIsNoteExpanded(false); setResubmitFiles([]); setResubmitNote(''); setUploadStatus(''); 
                fetchMyApplications(); 
            }
        } catch (err) { setUploadStatus(getErrorMessage(err, t, 'student_resubmission_failed')); }
    };

    return (
        <div style={{ marginTop: '10px' }}>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                <button onClick={() => setStudentTab('dashboard')} style={{ padding: '10px 20px', cursor: 'pointer', border: 'none', borderRadius: '5px', fontWeight: 'bold', backgroundColor: studentTab === 'dashboard' ? 'var(--brand)' : 'var(--surface-accent)', color: studentTab === 'dashboard' ? 'white' : 'var(--link)' }}>{t('student_tab_status')}</button>
                <button onClick={() => setStudentTab('submit')} style={{ padding: '10px 20px', cursor: 'pointer', border: 'none', borderRadius: '5px', fontWeight: 'bold', backgroundColor: studentTab === 'submit' ? 'var(--brand)' : 'var(--surface-accent)', color: studentTab === 'submit' ? 'white' : 'var(--link)' }}>{t('student_tab_submit')}</button>
            </div>

            {/* STATUS TAB */}
            {studentTab === 'dashboard' && (
                <div style={{ backgroundColor: 'var(--success-surface)', padding: '20px', borderRadius: '10px', border: '2px solid var(--success-border)' }}>
                    <h2 style={{ marginTop: 0, color: 'var(--success-text)' }}>{t('student_my_applications')}</h2>
                    <table style={{ width: '100%', borderCollapse: 'collapse', backgroundColor: 'var(--surface)', border: '2px solid var(--success-border)' }}>
                        <thead>
                            <tr style={{ backgroundColor: 'var(--accent)', color: 'white' }}>
                                <th style={{ padding: '12px', textAlign: 'left' }}>Fulfilled Courses</th>
                                <th style={{ padding: '12px', textAlign: 'left' }}>{t('reviewer_target_courses')}</th>
                                <th style={{ padding: '12px', textAlign: 'center' }}>Status</th>
                                <th style={{ padding: '12px', textAlign: 'center' }}>{t('reviewer_actions')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {myApplications.length === 0 ? (
                                <tr><td colSpan="4" style={{ textAlign: 'center', padding: '20px' }}>{t('student_no_applications')}</td></tr>
                            ) : myApplications.map(app => {
                                const coursesList = parseCourses(app.fulfilled_courses_json);
                                return (
                                <tr key={app.id} style={{ borderBottom: '2px solid var(--border)' }}>
                                    <td style={{ padding: '12px', verticalAlign: 'top' }}>
                                        <ul style={{ margin: 0, paddingLeft: '15px' }}>
                                            {coursesList.map((c, idx) => <li key={idx}><strong>{c.course_name}</strong> ({c.credits} Cr)</li>)}
                                        </ul>
                                    </td>
                                    <td style={{ padding: '12px', color: 'var(--link)', verticalAlign: 'top' }}>
                                        <ul style={{ margin: 0, paddingLeft: '15px' }}>
                                            {app.pte_course_names ? app.pte_course_names.split(' + ').map((courseName, idx) => (
                                                <li key={idx}>{courseName}</li>
                                            )) : <li>{t('reviewer_no_courses_listed')}</li>}
                                        </ul>
                                    </td>
                                    <td style={{ padding: '12px', textAlign: 'center', verticalAlign: 'top' }}>
                                        <span style={{ fontWeight: 'bold', padding: '5px 10px', borderRadius: '15px', color: 'white', fontSize: '11px', backgroundColor: app.status === 'approved' ? 'var(--brand)' : app.status === 'rejected' ? 'var(--red)' : app.status === 'needs_info' ? 'var(--orange)' : 'var(--blue)' }}>
                                            {t(`status_${app.status}`)}
                                        </span>
                                    </td>
                                    <td style={{ padding: '12px', textAlign: 'center', verticalAlign: 'top' }}>
                                        {app.status === 'needs_info' ? (
                                            <button onClick={() => setResubmitModal({ isOpen: true, app: app })} style={{ padding: '6px 12px', backgroundColor: 'var(--orange)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>{t('student_add_missing_info')}</button>
                                        ) : <span style={{ color: 'var(--text-muted)', fontSize: '14px' }}>{t('student_locked_action')}</span>}
                                    </td>
                                </tr>
                            )})}
                        </tbody>
                    </table>
                </div>
            )}

            {/* PHASE 3: RESUBMIT MODAL */}
            {resubmitModal.isOpen && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'var(--overlay)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, overflowY: 'auto' }}>
                    <div style={{ backgroundColor: 'var(--surface)', padding: '25px', borderRadius: '10px', width: '90vw', maxWidth: '900px', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 5px 15px rgba(0,0,0,0.3)' }}>
                        <h3 style={{ marginTop: 0, color: 'var(--orange-text)' }}>{t('student_action_required')}</h3>
                        
                        <div style={{ backgroundColor: 'var(--warning-bg)', padding: '15px', borderRadius: '5px', marginBottom: '15px', borderLeft: '5px solid var(--orange)' }}>
                            <strong style={{ color: 'var(--warning-text)' }}>{t('student_reviewer_note')}</strong>
                            <p style={{ margin: '5px 0 0 0', color: 'var(--text-secondary)', fontStyle: 'italic', wordBreak: 'break-word' }}>
                                "{resubmitModal.app.reviewer_note.length > 150 && !isNoteExpanded ? resubmitModal.app.reviewer_note.substring(0, 150) + '...' : resubmitModal.app.reviewer_note}"
                                {resubmitModal.app.reviewer_note.length > 150 && (
                                    <button onClick={() => setIsNoteExpanded(!isNoteExpanded)} style={{ background: 'none', border: 'none', color: 'var(--link-alt)', cursor: 'pointer', fontWeight: 'bold', padding: '0 5px', fontSize: '13px' }}>
                                        {isNoteExpanded ? t('student_see_less') : t('student_see_more')}
                                    </button>
                                )}
                            </p>
                        </div>

                        <label style={{ fontWeight: 'bold', color: 'var(--link)', display: 'block', marginBottom: '8px' }}>Your Reply to Reviewer:</label>
                        <textarea 
                            value={resubmitNote}
                            onChange={(e) => setResubmitNote(e.target.value)}
                            rows="3"
                            style={{ width: '100%', padding: '10px', borderRadius: '5px', border: '1px solid var(--border-strong)', boxSizing: 'border-box', marginBottom: '15px' }}
                            placeholder="Explain what you have updated or attach new highlighted files below..."
                        />

                        <label style={{ fontWeight: 'bold', color: 'var(--link)', display: 'block', marginBottom: '8px' }}>Upload Additional Evidence:</label>
                        <div style={{ backgroundColor: 'var(--surface-2)', padding: '15px', border: '2px dashed var(--orange)', borderRadius: '5px', marginBottom: '20px' }}>
                            <input type="file" onChange={(e) => handleFileSelect(e, true)} style={{ marginBottom: '10px' }}/>
                            
                            {resubmitPreviewUrl && (
                                <div style={{ marginTop: '10px' }}>
                                    <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                                        <button onClick={() => setActiveTool('pen')} style={{ padding: '5px 10px', backgroundColor: activeTool === 'pen' ? 'var(--control-active)' : 'var(--surface)', border: '1px solid var(--control-border)', borderRadius: '4px' }}>{t('student_tool_pen')}</button>
                                        <button onClick={() => setActiveTool('eraser')} style={{ padding: '5px 10px', backgroundColor: activeTool === 'eraser' ? 'var(--control-active)' : 'var(--surface)', border: '1px solid var(--control-border)', borderRadius: '4px' }}>{t('student_tool_eraser')}</button>
                                        <button onClick={handleClearCanvas} style={{ padding: '5px 10px', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '4px' }}>{t('student_tool_clear')}</button>
                                        <button onClick={() => clearUploadSelection(true)} style={{ padding: '5px 10px', backgroundColor: 'var(--grey)', color: 'white', border: 'none', borderRadius: '4px' }}>{t('student_remove_selected_file')}</button>
                                    </div>
                                    <div style={{ position: 'relative', display: 'block', width: '100%', maxWidth: '820px', margin: '0 auto', border: '1px solid #000' }}>
                                        <img ref={imgRef} src={resubmitPreviewUrl} onLoad={handleImageLoad} style={{ width: '100%', height: 'auto', display: 'block' }} alt={t('student_syllabus_alt')} />
                                        <canvas ref={canvasRef} onMouseDown={({ nativeEvent: { offsetX, offsetY } }) => { ctx.beginPath(); ctx.moveTo(offsetX, offsetY); ctx.lineWidth = activeTool === 'pen' ? 3 : 30; ctx.strokeStyle = 'red'; ctx.globalCompositeOperation = activeTool === 'pen' ? 'source-over' : 'destination-out'; setIsDrawing(true); }} onMouseMove={({ nativeEvent: { offsetX, offsetY } }) => { if (isDrawing) { ctx.lineTo(offsetX, offsetY); ctx.stroke(); } }} onMouseUp={() => setIsDrawing(false)} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', cursor: activeTool === 'pen' ? 'crosshair' : 'cell' }} />
                                    </div><br/>
                                    <button onClick={() => handleUploadHighlighted(true)} style={{ marginTop: '10px', padding: '8px 15px', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>{t('student_save_highlighted')}</button>
                                </div>
                            )}

                            {resubmitRawFile && (
                                <div style={{ marginTop: '10px', padding: '10px', backgroundColor: 'var(--surface-accent)', borderRadius: '5px' }}>
                                    <p style={{ margin: '0 0 10px 0', fontSize: '13px', color: 'var(--link)' }}>📄 <strong>{resubmitRawFile.name}</strong></p>
                                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                                        <button onClick={() => handleStandardUpload(true)} style={{ padding: '8px 15px', backgroundColor: 'var(--brand)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>{t('student_attach_document')}</button>
                                        <button onClick={() => clearUploadSelection(true)} style={{ padding: '8px 15px', backgroundColor: 'var(--grey)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>{t('student_remove_selected_file')}</button>
                                    </div>
                                </div>
                            )}

                            {resubmitFiles.length > 0 && (
                                <div style={{ marginTop: '15px' }}>
                                    <strong style={{ color: 'var(--success-accent)' }}>Attached New Files:</strong>
                                    {/* Same thumbnail + Open file + Remove layout as the first upload */}
                                    {resubmitFiles.map((file, idx) => (
                                        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' }}>
                                            <a href="#open-file" onClick={(e) => handleOpenFile(e, file)} style={{ display: 'flex', alignItems: 'center', gap: '5px', textDecoration: 'none' }}>
                                                {isImageFile(file) ? (
                                                    <SecureImage 
                                                        fileName={file} 
                                                        alt={t('student_evidence_preview_alt')}
                                                        style={{ height: '35px', borderRadius: '3px', border: '2px solid var(--accent)', cursor: 'zoom-in' }} 
                                                    />
                                                ) : (
                                                    <span style={{ fontSize: '13px', color: 'var(--link-alt)', fontWeight: 'bold', wordBreak: 'break-all' }}>📄 {file}</span>
                                                )}
                                                <span style={{ fontSize: '12px', color: 'var(--success-accent)', fontWeight: 'bold' }}>{t('student_open_file')}</span>
                                            </a>
                                            <button onClick={() => handleDeleteResubmitFile(file)} style={{ padding: '6px 10px', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>{t('student_remove_file')}</button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {uploadStatus && <p style={{ color: 'var(--link)', fontWeight: 'bold', marginBottom: '10px', textAlign: 'center' }}>{uploadStatus}</p>}
                        
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                            <button onClick={() => { setResubmitModal({ isOpen: false, app: null }); setResubmitPreviewUrl(null); setResubmitRawFile(null); setResubmitNote(''); setResubmitFiles([]); }} style={{ padding: '10px 15px', cursor: 'pointer', border: '1px solid var(--border-strong)', borderRadius: '4px' }}>{t('student_cancel')}</button>
                            <button onClick={submitResubmission} style={{ padding: '10px 15px', cursor: 'pointer', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>{t('student_resubmit_button')}</button>
                        </div>
                    </div>
                </div>
            )}

            {/* SUBMIT NEW APPLICATION TAB */}
            {studentTab === 'submit' && (
                <div style={{ backgroundColor: 'var(--success-surface)', padding: '20px', borderRadius: '10px', border: '2px solid var(--success-border)' }}>
                    <h2 style={{ marginTop: 0, color: 'var(--link)' }}>{t('student_new_application_title')}</h2>

                    {/* Previous institutions: entered once, then chosen on each course row */}
                    <section aria-labelledby="institutions-title" style={{ backgroundColor: 'var(--surface)', padding: '15px', borderRadius: '5px', marginBottom: '20px' }}>
                        <h3 id="institutions-title" style={{ margin: '0 0 5px 0', color: 'var(--link)' }}>{t('student_institutions_title')}</h3>
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 10px 0' }}>{t('student_institutions_help')}</p>
                        {institutions.map((inst, i) => (
                            <div key={inst.key} style={{ border: '1px solid var(--border)', borderRadius: '5px', padding: '10px', marginBottom: '10px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                                    <h4 style={{ margin: 0, color: 'var(--link)' }}>{t('student_institution_heading', { n: i + 1 })}</h4>
                                    {institutions.length > 1 && (
                                        <button type="button" disabled={gradingStatus[inst.key]?.uploading} onClick={() => handleRemoveInstitution(inst.key)} style={{ padding: '5px 10px', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}>{t('student_remove_institution')}</button>
                                    )}
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '15px' }}>
                                    <div>
                                        <label htmlFor={`inst-name-${inst.key}`} style={fieldLabelStyle}>{t('student_institution_name')}</label>
                                        <input id={`inst-name-${inst.key}`} type="text" value={inst.name} onChange={(e) => handleInstitutionChange(inst.key, 'name', e.target.value)} style={fieldInputStyle} />
                                    </div>
                                    <div>
                                        <label htmlFor={`inst-country-${inst.key}`} style={fieldLabelStyle}>{t('student_institution_country')}</label>
                                        <select id={`inst-country-${inst.key}`} value={inst.country} onChange={(e) => handleInstitutionChange(inst.key, 'country', e.target.value)} style={fieldInputStyle}>
                                            <option value="">{t('student_country_placeholder')}</option>
                                            {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                                        </select>
                                    </div>
                                </div>

                                {/* Grading-system document: one per institution, no highlighting */}
                                <div style={{ marginTop: '12px' }}>
                                    <span id={`inst-grading-label-${inst.key}`} style={fieldLabelStyle}>{t('student_grading_doc_label')}</span>
                                    <p id={`inst-grading-help-${inst.key}`} style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 6px 0' }}>{t('student_grading_doc_help')}</p>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                                        {/* Translated button; the browser's own "Choose file" input stays hidden */}
                                        <button
                                            type="button" disabled={gradingStatus[inst.key]?.uploading}
                                            onClick={() => gradingInputs.current[inst.key]?.click()}
                                            aria-describedby={`inst-grading-label-${inst.key} inst-grading-help-${inst.key}`}
                                            style={{ padding: '8px 12px', backgroundColor: inst.grading_file ? 'var(--accent)' : 'var(--blue)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                                        >
                                            {inst.grading_file ? t('student_grading_doc_replace') : t('student_grading_doc_upload')}
                                        </button>
                                        {inst.grading_file && (
                                            <>
                                                <span style={{ fontSize: '13px', color: 'var(--link-alt)', fontWeight: 'bold', wordBreak: 'break-all' }}>📄 {inst.grading_file}</span>
                                                <a href="#open-file" onClick={(e) => handleOpenFile(e, inst.grading_file)} style={{ fontSize: '12px', color: 'var(--success-accent)', fontWeight: 'bold' }}>{t('student_open_file')}</a>
                                                <button type="button" disabled={gradingStatus[inst.key]?.uploading} onClick={() => handleRemoveGradingFile(inst.key, inst.grading_file)} style={{ padding: '6px 10px', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>{t('student_remove_file')}</button>
                                            </>
                                        )}
                                    </div>
                                    <input
                                        ref={(el) => { gradingInputs.current[inst.key] = el; }}
                                        type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" tabIndex={-1} style={{ display: 'none' }}
                                        // Cleared after each choice, so the same file can be chosen again
                                        onChange={(e) => { handleGradingFileChosen(inst.key, e.target.files[0]); e.target.value = ''; }}
                                    />
                                    {gradingStatus[inst.key]?.uploading && <p role="status" style={{ color: 'var(--link)', fontWeight: 'bold', margin: '6px 0 0 0' }}>{t('student_grading_doc_uploading')}</p>}
                                    {gradingStatus[inst.key]?.message && <p role="alert" style={{ color: 'var(--error-text)', fontWeight: 'bold', margin: '6px 0 0 0' }}>{gradingStatus[inst.key].message}</p>}
                                </div>
                            </div>
                        ))}
                        <button type="button" onClick={handleAddInstitution} style={{ padding: '8px 12px', backgroundColor: 'var(--grey)', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>{t('student_add_institution')}</button>
                    </section>
                    
                    {fulfilledCourses.map((course, index) => (
                        <div key={course.id} style={{ backgroundColor: 'var(--surface)', padding: '15px', borderRadius: '5px', marginBottom: '15px', position: 'relative', borderLeft: course.file ? '5px solid var(--accent)' : '5px solid var(--red)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                                <h4 style={{ margin: 0, color: 'var(--link)' }}>{t('student_fulfilled_course_heading', { n: index + 1 })}</h4>
                                {/* At least one row always stays, so the only row has no remove button */}
                                {fulfilledCourses.length > 1 && (
                                    <button type="button" onClick={() => handleRemoveCourseRow(course.id)} aria-label={t('student_remove_course_aria', { n: index + 1 })} style={{ padding: '5px 10px', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}>{t('student_remove_course')}</button>
                                )}
                            </div>
                            {rowMessages[course.id] && <p role="alert" style={{ color: 'var(--error-text)', fontWeight: 'bold', margin: '0 0 10px 0' }}>{rowMessages[course.id]}</p>}
                            
                            <div style={{ marginBottom: '10px' }}>
                                <label htmlFor={`row-inst-${course.id}`} style={fieldLabelStyle}>{t('student_course_institution')}</label>
                                <select id={`row-inst-${course.id}`} value={course.institutionKey} onChange={(e) => handleCourseChange(course.id, 'institutionKey', e.target.value)} style={fieldInputStyle}>
                                    <option value="">{t('student_course_institution_placeholder')}</option>
                                    {institutions.map((inst, i) => <option key={inst.key} value={inst.key}>{institutionLabel(inst, i)}</option>)}
                                </select>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '10px' }}>
                                <div>
                                    <label htmlFor={`row-name-${course.id}`} style={fieldLabelStyle}>{t('student_fulfilled_course_label')}</label>
                                    <input id={`row-name-${course.id}`} type="text" value={course.course_name} onChange={(e) => handleCourseChange(course.id, 'course_name', e.target.value)} style={fieldInputStyle} />
                                </div>
                                <div>
                                    <label htmlFor={`row-code-${course.id}`} style={fieldLabelStyle}>{t('student_course_code_label')}</label>
                                    <input id={`row-code-${course.id}`} type="text" value={course.course_code} onChange={(e) => handleCourseChange(course.id, 'course_code', e.target.value)} style={fieldInputStyle} />
                                </div>
                                <div>
                                    <label htmlFor={`row-credits-${course.id}`} style={fieldLabelStyle}>{t('student_total_credits_label')} {matches.credits && <span style={{ color: 'var(--ok-text)' }}>✅</span>}</label>
                                    <input id={`row-credits-${course.id}`} type="number" step="0.5" min="0.5" inputMode="decimal" value={course.credits} onChange={(e) => handleCourseChange(course.id, 'credits', e.target.value)} style={fieldInputStyle} />
                                </div>
                                <div>
                                    <label htmlFor={`row-system-${course.id}`} style={fieldLabelStyle}>{t('student_credit_system')}</label>
                                    <select id={`row-system-${course.id}`} value={course.credit_system} onChange={(e) => handleCourseChange(course.id, 'credit_system', e.target.value)} style={fieldInputStyle}>
                                        <option value="">{t('student_credit_system_placeholder')}</option>
                                        {CREDIT_SYSTEMS.map((system) => <option key={system} value={system}>{t(`student_credit_system_${system}`)}</option>)}
                                    </select>
                                </div>
                                {course.credit_system === 'OTHER' && (
                                    <div>
                                        <label htmlFor={`row-system-other-${course.id}`} style={fieldLabelStyle}>{t('student_credit_system_other_label')}</label>
                                        <input id={`row-system-other-${course.id}`} type="text" value={course.credit_system_other} onChange={(e) => handleCourseChange(course.id, 'credit_system_other', e.target.value)} style={fieldInputStyle} />
                                    </div>
                                )}
                                <div>
                                    <label htmlFor={`row-grade-${course.id}`} style={fieldLabelStyle}>{t('student_grade_label')}</label>
                                    <input id={`row-grade-${course.id}`} type="text" value={course.grade} onChange={(e) => handleCourseChange(course.id, 'grade', e.target.value)} style={fieldInputStyle} />
                                </div>
                            </div>
                            
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <button onClick={() => triggerUploadForCourse(course.id)} style={{ padding: '8px 12px', backgroundColor: course.file ? 'var(--accent)' : 'var(--blue)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                                    {activeUploadId === course.id ? t('student_close_uploader') : (course.file ? t('student_replace_evidence') : t('student_upload_syllabus'))}
                                </button>
                                
                                {/* Clickable Thumbnail! */}
                                {course.file && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                        <a href="#open-file" onClick={(e) => handleOpenFile(e, course.file)} style={{ display: 'flex', alignItems: 'center', gap: '5px', textDecoration: 'none' }}>
                                            {isImageFile(course.file) ? (
                                                <SecureImage 
                                                    fileName={course.file} 
                                                    alt={t('student_evidence_preview_alt')}
                                                    style={{ height: '35px', borderRadius: '3px', border: '2px solid var(--accent)', cursor: 'zoom-in' }} 
                                                />
                                            ) : (
                                                <span style={{ fontSize: '13px', color: 'var(--link-alt)', fontWeight: 'bold' }}>{course.file}</span>
                                            )}
                                            <span style={{ fontSize: '12px', color: 'var(--success-accent)', fontWeight: 'bold' }}>{t('student_open_file')}</span>
                                        </a>
                                        <button onClick={() => handleDeleteUploadedFile(course.id, course.file)} style={{ padding: '6px 10px', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>{t('student_remove_file')}</button>
                                    </div>
                                )}
                            </div>

                            {/* --- INLINE UPLOADER --- */}
                            {activeUploadId === course.id && (
                                <div style={{ backgroundColor: 'var(--surface-2)', padding: '15px', border: '2px dashed var(--blue)', borderRadius: '5px', marginTop: '15px' }}>
                                    <h4 style={{ marginTop: 0 }}>{t('student_upload_evidence_title')}</h4>
                                    <input type="file" onChange={(e) => handleFileSelect(e, false)} />
                                    
                                    {previewUrl && (
                                        <div style={{ marginTop: '10px' }}>
                                            <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                                                <button onClick={() => setActiveTool('pen')} style={{ padding: '5px 10px', backgroundColor: activeTool === 'pen' ? 'var(--control-active)' : 'var(--surface)', border: '1px solid var(--control-border)', borderRadius: '4px' }}>{t('student_tool_pen')}</button>
                                                <button onClick={() => setActiveTool('eraser')} style={{ padding: '5px 10px', backgroundColor: activeTool === 'eraser' ? 'var(--control-active)' : 'var(--surface)', border: '1px solid var(--control-border)', borderRadius: '4px' }}>{t('student_tool_eraser')}</button>
                                                <button onClick={handleClearCanvas} style={{ padding: '5px 10px', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '4px' }}>{t('student_tool_clear')}</button>
                                                <button onClick={() => clearUploadSelection(false)} style={{ padding: '5px 10px', backgroundColor: 'var(--grey)', color: 'white', border: 'none', borderRadius: '4px' }}>{t('student_remove_selected_file')}</button>
                                            </div>
                                            <div style={{ position: 'relative', display: 'block', width: '100%', maxWidth: '820px', margin: '0 auto', border: '1px solid #000' }}>
                                                <img ref={imgRef} src={previewUrl} onLoad={handleImageLoad} style={{ width: '100%', height: 'auto', display: 'block' }} alt={t('student_syllabus_alt')} />
                                                <canvas ref={canvasRef} onMouseDown={({ nativeEvent: { offsetX, offsetY } }) => { ctx.beginPath(); ctx.moveTo(offsetX, offsetY); ctx.lineWidth = activeTool === 'pen' ? 3 : 30; ctx.strokeStyle = 'red'; ctx.globalCompositeOperation = activeTool === 'pen' ? 'source-over' : 'destination-out'; setIsDrawing(true); }} onMouseMove={({ nativeEvent: { offsetX, offsetY } }) => { if (isDrawing) { ctx.lineTo(offsetX, offsetY); ctx.stroke(); } }} onMouseUp={() => setIsDrawing(false)} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', cursor: activeTool === 'pen' ? 'crosshair' : 'cell' }} />
                                            </div><br/>
                                            <button onClick={() => handleUploadHighlighted(false)} style={{ marginTop: '10px', padding: '8px 15px', backgroundColor: 'var(--accent)', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 'bold', borderRadius: '4px' }}>{t('student_save_highlighted')}</button>
                                        </div>
                                    )}

                                    {rawFile && (
                                        <div style={{ marginTop: '10px', padding: '10px', backgroundColor: 'var(--surface-accent)', borderRadius: '5px' }}>
                                            <p style={{ margin: '0 0 10px 0', fontSize: '13px', color: 'var(--link)' }}>📄 <strong>{rawFile.name}</strong></p>
                                            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                                                <button onClick={() => handleStandardUpload(false)} style={{ padding: '8px 15px', backgroundColor: 'var(--brand)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>{t('student_attach_document')}</button>
                                                <button onClick={() => clearUploadSelection(false)} style={{ padding: '8px 15px', backgroundColor: 'var(--grey)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>{t('student_remove_selected_file')}</button>
                                            </div>
                                        </div>
                                    )}

                                    {uploadStatus && <p style={{ color: 'var(--link)', fontWeight: 'bold', marginTop: '10px' }}>{uploadStatus}</p>}
                                </div>
                            )}
                        </div>
                    ))}

                    <button onClick={handleAddCourseRow} style={{ padding: '10px', backgroundColor: 'var(--grey)', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', marginBottom: '20px', width: '100%' }}>{t('student_add_course')}</button>

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ fontWeight: 'bold', color: 'var(--link)' }}>{t('student_select_pte_courses_label')}</label>
                        {noCourses ? (
                            <p role="status" style={{ backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)', padding: '10px', borderRadius: '5px', margin: '5px 0 0' }}>{t('student_no_courses_for_programme')}</p>
                        ) : (
                        <select value="" onChange={(e) => { const course = courses.find(c => c.id === parseInt(e.target.value)); if (course && !selectedCourses.find(sc => sc.id === course.id)) setSelectedCourses([...selectedCourses, course]); }} style={{ width: '100%', padding: '10px', marginTop: '5px', border: '1px solid var(--border-strong)', borderRadius: '4px' }}>
                            <option value="">{t('student_select_pte_courses_placeholder')}</option>
                            {courses.map(c => <option key={c.id} value={c.id}>{t('student_target_course_chip', { code: c.course_code, name: c.course_name, credits: c.credits })}</option>)}
                        </select>
                        )}
                        <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                            {selectedCourses.map(sc => (
                                <span key={sc.id} style={{ backgroundColor: 'var(--teal)', color: 'white', padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold', maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere', display: 'inline-flex', alignItems: 'center' }}>
                                    {t('student_target_course_chip', { code: sc.course_code, name: sc.course_name, credits: sc.credits })}
                                    <button type="button" aria-label={t('student_remove_target_course', { code: sc.course_code })} onClick={() => setSelectedCourses(selectedCourses.filter(c => c.id !== sc.id))} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', marginLeft: '5px', flexShrink: 0 }}>×</button>
                                </span>
                            ))}
                        </div>
                    </div>

                    {evidenceRequiredMsg && <div style={{ backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)', padding: '15px', borderRadius: '5px', marginBottom: '20px' }}>{evidenceRequiredMsg}</div>}

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ fontWeight: 'bold', color: 'var(--link)' }}>{t('student_notes_label')}</label>
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '5px 0' }}>{t('student_notes_help')}</p>
                        <textarea 
                            value={studentNote}
                            onChange={(e) => setStudentNote(e.target.value)}
                            rows="4"
                            style={{ width: '100%', padding: '10px', borderRadius: '5px', border: '1px solid var(--border-strong)', boxSizing: 'border-box' }}
                            placeholder={t('student_notes_placeholder')}
                        />
                    </div>

                    {!isSubmissionsOpen && (
                        <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', border: '1px solid var(--danger-border)', padding: '15px', borderRadius: '5px', marginBottom: '20px' }}>
                            {t('student_submissions_closed', 'Submissions are currently closed. Please check back later.')}
                        </div>
                    )}

                    <button
                        onClick={handleSubmitApplication}
                        disabled={!canSubmit}
                        style={{
                            width: '100%',
                            padding: '15px',
                            backgroundColor: canSubmit ? 'var(--brand)' : 'var(--grey)',
                            color: 'white',
                            fontWeight: 'bold',
                            cursor: canSubmit ? 'pointer' : 'not-allowed',
                            border: 'none',
                            borderRadius: '5px'
                        }}
                    >
                        {t('student_submit_package')}
                    </button>
                    {submitStatus && <p style={{ color: 'var(--error-text)', textAlign: 'center', fontWeight: 'bold', marginTop: '10px' }}>{submitStatus}</p>}
                </div>
            )}
        </div>
    );
};

export default StudentDashboard;