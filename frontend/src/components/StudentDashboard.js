import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import * as pdfjsLib from 'pdfjs-dist';

// Set up the worker for PDF.js to handle conversions
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const StudentDashboard = ({ userId }) => {
    const { t } = useTranslation();
    const [courses, setCourses] = useState([]);
    const [studentTab, setStudentTab] = useState('dashboard');
    
    // --- PHASE 1: Dynamic Spreadsheet Data ---
    const [fulfilledCourses, setFulfilledCourses] = useState([
        { id: Date.now(), course_name: '', course_code: '', credits: '', grade: '', file: null }
    ]);
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

    const fetchCourses = useCallback(async () => {
        try {
            const res = await axios.get('/api/pte-courses');
            if (res.data.success) setCourses(res.data.courses); 
        } catch (err) { console.error(err); }
    }, []);

    const fetchMyApplications = useCallback(async () => {
        if (!userId) return;
        try {
            const res = await axios.get(`/api/applications/student/${userId}`);
            if (res.data.success) setMyApplications(res.data.applications);
        } catch (err) { console.error('Error fetching student apps', err); }
    }, [userId]);

    const fetchSystemStatus = useCallback(async () => {
        try {
            const res = await axios.get('/api/settings/status');
            if (res.data.success) setIsSubmissionsOpen(res.data.isOpen);
        } catch (err) {
            console.error('Error fetching system status', err);
        }
    }, []);

    useEffect(() => {
        fetchCourses();
        fetchMyApplications();
        fetchSystemStatus();
    }, [fetchCourses, fetchMyApplications, fetchSystemStatus]);

    // Validation & Credit Math
    useEffect(() => {
        if (selectedCourses.length > 0 && fulfilledCourses[0].course_name) {
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
    const handleAddCourseRow = () => setFulfilledCourses([...fulfilledCourses, { id: Date.now(), course_name: '', course_code: '', credits: '', grade: '', file: null }]);
    const handleRemoveCourseRow = (id) => setFulfilledCourses(fulfilledCourses.filter(c => c.id !== id));
    const handleCourseChange = (id, field, value) => setFulfilledCourses(fulfilledCourses.map(c => c.id === id ? { ...c, [field]: value } : c));
    
    const getUploadEndpoint = (fileName = '') => `/api/uploads${fileName ? `/${encodeURIComponent(fileName)}` : ''}`;
    const getUploadLink = (fileName) => `http://localhost:5000/api/uploads/${encodeURIComponent(fileName)}`;
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
            await axios.delete(getUploadEndpoint(fileName));
            // Only removes the file from the specific course row
            setFulfilledCourses(fulfilledCourses.map(c => c.id === courseId ? { ...c, file: null } : c));
            if (activeUploadId === courseId) setActiveUploadId(null);
        } catch (err) {
            console.error('Delete upload error', err);
            alert('Could not remove the uploaded file. Please try again.');
        }
    };

    // Delete a file specifically from the Resubmit Modal
    const handleDeleteResubmitFile = async (fileName) => {
        if (!fileName) return;
        try {
            await axios.delete(getUploadEndpoint(fileName));
            // Remove the file from the resubmit array so it disappears from the UI
            setResubmitFiles(prev => prev.filter(f => f !== fileName));
        } catch (err) {
            console.error('Delete resubmit upload error', err);
            alert('Could not remove the uploaded file. Please try again.');
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
        try {
            const res = await axios.post('/api/uploads', formData);
            if (res.data.success) {
                if (isResubmit) {
                    setResubmitFiles(prev => [...prev, res.data.fileName]);
                    setResubmitPreviewUrl(null); 
                    setResubmitRawFile(null);
                } else {
                    // This is where it attaches the file specifically to the course case!
                    setFulfilledCourses(fulfilledCourses.map(c => c.id === activeUploadId ? { ...c, file: res.data.fileName } : c));
                    setTimeout(() => { setPreviewUrl(null); setRawFile(null); setActiveUploadId(null); }, 1000);
                }
                setUploadStatus(t('student_upload_saved'));
                setTimeout(() => setUploadStatus(''), 2000);
            }
        } catch (err) { setUploadStatus(t('student_upload_failed')); }
    }

    const handleSubmitApplication = async () => {
        if (!isSubmissionsOpen) return setSubmitStatus(t('student_submissions_closed', 'Submissions are currently closed.'));

        const isValid = fulfilledCourses.every(c => c.course_name.trim() !== '' && c.file !== null);
        if (!isValid || selectedCourses.length === 0) return setSubmitStatus(t('student_submit_complete_fields'));

        try {
            setSubmitStatus(t('student_submit_saving'));
            const targetCourseNames = selectedCourses.map(c => `${c.course_code} (${c.course_name})`).join(' + ');

            const response = await axios.post('/api/applications', {
                student_id: userId, 
                fulfilled_courses_json: fulfilledCourses, 
                pte_course_names: targetCourseNames, 
                system_note: evidenceRequiredMsg,
                student_note: studentNote 
            });
            
            if (response.data.success) {
                alert(t('student_submission_success'));
                setFulfilledCourses([{ id: Date.now(), course_name: '', course_code: '', credits: '', grade: '', file: null }]);
                setSelectedCourses([]); setActiveUploadId(null); setPreviewUrl(null); setSubmitStatus(''); setStudentNote('');
                fetchMyApplications(); 
                setStudentTab('dashboard');
            }
        } catch (err) { setSubmitStatus(t('student_submission_failed')); }
    };

    const submitResubmission = async () => {
        if (!isSubmissionsOpen) return alert(t('student_submissions_closed', 'Submissions are currently closed.'));
        if (resubmitFiles.length === 0 && resubmitNote.trim() === '') return alert(t('student_resubmit_missing_info_alert'));
        try {
            setUploadStatus(t('student_resubmission_sending'));
            const res = await axios.put(`/api/applications/${resubmitModal.app.id}/resubmit`, { 
                student_resubmit_note: resubmitNote,
                new_files: resubmitFiles.join(',') 
            });
            if (res.data.success) {
                alert(t('student_resubmission_success'));
                setResubmitModal({ isOpen: false, app: null }); setIsNoteExpanded(false); setResubmitFiles([]); setResubmitNote(''); setUploadStatus(''); 
                fetchMyApplications(); 
            }
        } catch (err) { setUploadStatus(t('student_resubmission_failed')); }
    };

    return (
        <div style={{ marginTop: '10px' }}>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                <button onClick={() => setStudentTab('dashboard')} style={{ padding: '10px 20px', cursor: 'pointer', border: 'none', borderRadius: '5px', fontWeight: 'bold', backgroundColor: studentTab === 'dashboard' ? '#004085' : '#e2e3f0', color: studentTab === 'dashboard' ? 'white' : '#004085' }}>{t('student_tab_status')}</button>
                <button onClick={() => setStudentTab('submit')} style={{ padding: '10px 20px', cursor: 'pointer', border: 'none', borderRadius: '5px', fontWeight: 'bold', backgroundColor: studentTab === 'submit' ? '#004085' : '#e2e3f0', color: studentTab === 'submit' ? 'white' : '#004085' }}>{t('student_tab_submit')}</button>
            </div>

            {/* STATUS TAB */}
            {studentTab === 'dashboard' && (
                <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '10px', border: '1px solid #ccc' }}>
                    <h2 style={{ marginTop: 0, color: '#004085' }}>{t('student_my_applications')}</h2>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ backgroundColor: '#f8f9fa' }}>
                                <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Fulfilled Courses</th>
                                <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>{t('reviewer_target_courses')}</th>
                                <th style={{ padding: '12px', textAlign: 'center', borderBottom: '2px solid #ddd' }}>Status</th>
                                <th style={{ padding: '12px', textAlign: 'center', borderBottom: '2px solid #ddd' }}>{t('reviewer_actions')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {myApplications.length === 0 ? (
                                <tr><td colSpan="4" style={{ textAlign: 'center', padding: '20px' }}>{t('student_no_applications')}</td></tr>
                            ) : myApplications.map(app => {
                                const coursesList = parseCourses(app.fulfilled_courses_json);
                                return (
                                <tr key={app.id} style={{ borderBottom: '1px solid #eee' }}>
                                    <td style={{ padding: '12px', verticalAlign: 'top' }}>
                                        <ul style={{ margin: 0, paddingLeft: '15px' }}>
                                            {coursesList.map((c, idx) => <li key={idx}><strong>{c.course_name}</strong> ({c.credits} Cr)</li>)}
                                        </ul>
                                    </td>
                                    <td style={{ padding: '12px', color: '#004085', verticalAlign: 'top' }}>
                                        <ul style={{ margin: 0, paddingLeft: '15px' }}>
                                            {app.pte_course_names ? app.pte_course_names.split(' + ').map((courseName, idx) => (
                                                <li key={idx}>{courseName}</li>
                                            )) : <li>{t('reviewer_no_courses_listed')}</li>}
                                        </ul>
                                    </td>
                                    <td style={{ padding: '12px', textAlign: 'center', verticalAlign: 'top' }}>
                                        <span style={{ fontWeight: 'bold', padding: '5px 10px', borderRadius: '15px', color: 'white', fontSize: '11px', backgroundColor: app.status === 'approved' ? '#28a745' : app.status === 'rejected' ? '#dc3545' : app.status === 'needs_info' ? '#fd7e14' : '#007bff' }}>
                                            {t(`status_${app.status}`)}
                                        </span>
                                    </td>
                                    <td style={{ padding: '12px', textAlign: 'center', verticalAlign: 'top' }}>
                                        {app.status === 'needs_info' ? (
                                            <button onClick={() => setResubmitModal({ isOpen: true, app: app })} style={{ padding: '6px 12px', backgroundColor: '#fd7e14', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>{t('student_add_missing_info')}</button>
                                        ) : <span style={{ color: '#666', fontSize: '14px' }}>{t('student_locked_action')}</span>}
                                    </td>
                                </tr>
                            )})}
                        </tbody>
                    </table>
                </div>
            )}

            {/* PHASE 3: RESUBMIT MODAL */}
            {resubmitModal.isOpen && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, overflowY: 'auto' }}>
                    <div style={{ backgroundColor: '#fff', padding: '25px', borderRadius: '10px', width: '90vw', maxWidth: '900px', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 5px 15px rgba(0,0,0,0.3)' }}>
                        <h3 style={{ marginTop: 0, color: '#fd7e14' }}>{t('student_action_required')}</h3>
                        
                        <div style={{ backgroundColor: '#fff3cd', padding: '15px', borderRadius: '5px', marginBottom: '15px', borderLeft: '5px solid #fd7e14' }}>
                            <strong style={{ color: '#856404' }}>{t('student_reviewer_note')}</strong>
                            <p style={{ margin: '5px 0 0 0', color: '#555', fontStyle: 'italic', wordBreak: 'break-word' }}>
                                "{resubmitModal.app.reviewer_note.length > 150 && !isNoteExpanded ? resubmitModal.app.reviewer_note.substring(0, 150) + '...' : resubmitModal.app.reviewer_note}"
                                {resubmitModal.app.reviewer_note.length > 150 && (
                                    <button onClick={() => setIsNoteExpanded(!isNoteExpanded)} style={{ background: 'none', border: 'none', color: '#007bff', cursor: 'pointer', fontWeight: 'bold', padding: '0 5px', fontSize: '13px' }}>
                                        {isNoteExpanded ? t('student_see_less') : t('student_see_more')}
                                    </button>
                                )}
                            </p>
                        </div>

                        <label style={{ fontWeight: 'bold', color: '#004085', display: 'block', marginBottom: '8px' }}>Your Reply to Reviewer:</label>
                        <textarea 
                            value={resubmitNote}
                            onChange={(e) => setResubmitNote(e.target.value)}
                            rows="3"
                            style={{ width: '100%', padding: '10px', borderRadius: '5px', border: '1px solid #ccc', boxSizing: 'border-box', marginBottom: '15px' }}
                            placeholder="Explain what you have updated or attach new highlighted files below..."
                        />

                        <label style={{ fontWeight: 'bold', color: '#004085', display: 'block', marginBottom: '8px' }}>Upload Additional Evidence:</label>
                        <div style={{ backgroundColor: '#f8f9fa', padding: '15px', border: '2px dashed #fd7e14', borderRadius: '5px', marginBottom: '20px' }}>
                            <input type="file" onChange={(e) => handleFileSelect(e, true)} style={{ marginBottom: '10px' }}/>
                            
                            {resubmitPreviewUrl && (
                                <div style={{ marginTop: '10px' }}>
                                    <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                                        <button onClick={() => setActiveTool('pen')} style={{ padding: '5px 10px', backgroundColor: activeTool === 'pen' ? '#ccc' : '#fff', border: '1px solid #aaa', borderRadius: '4px' }}>Pen</button>
                                        <button onClick={() => setActiveTool('eraser')} style={{ padding: '5px 10px', backgroundColor: activeTool === 'eraser' ? '#ccc' : '#fff', border: '1px solid #aaa', borderRadius: '4px' }}>Eraser</button>
                                        <button onClick={handleClearCanvas} style={{ padding: '5px 10px', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '4px' }}>Clear</button>
                                        <button onClick={() => clearUploadSelection(true)} style={{ padding: '5px 10px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px' }}>Remove Selected File</button>
                                    </div>
                                    <div style={{ position: 'relative', display: 'block', width: '100%', maxWidth: '820px', margin: '0 auto', border: '1px solid #000' }}>
                                        <img ref={imgRef} src={resubmitPreviewUrl} onLoad={handleImageLoad} style={{ width: '100%', height: 'auto', display: 'block' }} alt="Syllabus" />
                                        <canvas ref={canvasRef} onMouseDown={({ nativeEvent: { offsetX, offsetY } }) => { ctx.beginPath(); ctx.moveTo(offsetX, offsetY); ctx.lineWidth = activeTool === 'pen' ? 3 : 30; ctx.strokeStyle = 'red'; ctx.globalCompositeOperation = activeTool === 'pen' ? 'source-over' : 'destination-out'; setIsDrawing(true); }} onMouseMove={({ nativeEvent: { offsetX, offsetY } }) => { if (isDrawing) { ctx.lineTo(offsetX, offsetY); ctx.stroke(); } }} onMouseUp={() => setIsDrawing(false)} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', cursor: activeTool === 'pen' ? 'crosshair' : 'cell' }} />
                                    </div><br/>
                                    <button onClick={() => handleUploadHighlighted(true)} style={{ marginTop: '10px', padding: '8px 15px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Save Highlighted Image</button>
                                </div>
                            )}

                            {resubmitRawFile && (
                                <div style={{ marginTop: '10px', padding: '10px', backgroundColor: '#e2e3f0', borderRadius: '5px' }}>
                                    <p style={{ margin: '0 0 10px 0', fontSize: '13px', color: '#004085' }}>📄 <strong>{resubmitRawFile.name}</strong></p>
                                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                                        <button onClick={() => handleStandardUpload(true)} style={{ padding: '8px 15px', backgroundColor: '#004085', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Attach Document</button>
                                        <button onClick={() => clearUploadSelection(true)} style={{ padding: '8px 15px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Remove Selected File</button>
                                    </div>
                                </div>
                            )}

                            {resubmitFiles.length > 0 && (
                                <div style={{ marginTop: '15px' }}>
                                    <strong style={{ color: '#28a745' }}>Attached New Files (Click to Preview):</strong>
                                    <ul style={{ margin: '5px 0', paddingLeft: '20px' }}>
                                        {resubmitFiles.map((file, idx) => (
                                            <li key={idx} style={{ color: '#555', wordBreak: 'break-all', marginBottom: '5px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                <a href={getUploadLink(file)} target="_blank" rel="noopener noreferrer" style={{ color: '#007bff', textDecoration: 'none', fontWeight: 'bold' }}>
                                                    {file} ↗
                                                </a>
                                                <button 
                                                    onClick={() => handleDeleteResubmitFile(file)} 
                                                    style={{ padding: '3px 8px', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}
                                                >
                                                    Remove
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>

                        {uploadStatus && <p style={{ color: '#004085', fontWeight: 'bold', marginBottom: '10px', textAlign: 'center' }}>{uploadStatus}</p>}
                        
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                            <button onClick={() => { setResubmitModal({ isOpen: false, app: null }); setResubmitPreviewUrl(null); setResubmitRawFile(null); setResubmitNote(''); setResubmitFiles([]); }} style={{ padding: '10px 15px', cursor: 'pointer', border: '1px solid #ccc', borderRadius: '4px' }}>{t('student_cancel')}</button>
                            <button onClick={submitResubmission} style={{ padding: '10px 15px', cursor: 'pointer', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>{t('student_resubmit_button')}</button>
                        </div>
                    </div>
                </div>
            )}

            {/* SUBMIT NEW APPLICATION TAB */}
            {studentTab === 'submit' && (
                <div style={{ backgroundColor: '#e2e3f0', padding: '20px', borderRadius: '10px', border: '1px solid #b8daff', maxWidth: '800px' }}>
                    <h2 style={{ marginTop: 0, color: '#004085' }}>{t('student_new_application_title')}</h2>
                    
                    {fulfilledCourses.map((course, index) => (
                        <div key={course.id} style={{ backgroundColor: '#fff', padding: '15px', borderRadius: '5px', marginBottom: '15px', position: 'relative', borderLeft: course.file ? '5px solid #28a745' : '5px solid #dc3545' }}>
                            <h4 style={{ margin: '0 0 10px 0', color: '#004085' }}>Course {index + 1}</h4>
                            {fulfilledCourses.length > 1 && <button onClick={() => handleRemoveCourseRow(course.id)} style={{ position: 'absolute', top: '10px', right: '10px', background: 'red', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer' }}>X</button>}
                            
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '10px' }}>
                                <div><label style={{ fontSize: '12px', fontWeight: 'bold' }}>{t('student_fulfilled_course_label')}</label><input type="text" value={course.course_name} onChange={(e) => handleCourseChange(course.id, 'course_name', e.target.value)} style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }} /></div>
                                <div><label style={{ fontSize: '12px', fontWeight: 'bold' }}>{t('student_course_code_label')}</label><input type="text" value={course.course_code} onChange={(e) => handleCourseChange(course.id, 'course_code', e.target.value)} style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }} /></div>
                                <div><label style={{ fontSize: '12px', fontWeight: 'bold' }}>{t('student_total_credits_label')} {matches.credits && <span style={{ color: 'green' }}>✅</span>}</label><input type="number" step="0.5" value={course.credits} onChange={(e) => handleCourseChange(course.id, 'credits', e.target.value)} style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }} /></div>
                                <div><label style={{ fontSize: '12px', fontWeight: 'bold' }}>{t('student_grade_label')}</label><input type="text" value={course.grade} onChange={(e) => handleCourseChange(course.id, 'grade', e.target.value)} style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }} /></div>
                            </div>
                            
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <button onClick={() => triggerUploadForCourse(course.id)} style={{ padding: '8px 12px', backgroundColor: course.file ? '#28a745' : '#007bff', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                                    {activeUploadId === course.id ? 'Close Uploader ▴' : (course.file ? 'Replace Evidence ▾' : 'Upload Syllabus (Required) ▾')}
                                </button>
                                
                                {/* Clickable Thumbnail! */}
                                {course.file && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                        <a href={getUploadLink(course.file)} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '5px', textDecoration: 'none' }}>
                                            {isImageFile(course.file) ? (
                                                <img 
                                                    src={getUploadLink(course.file)} 
                                                    alt="Evidence Preview"
                                                    style={{ height: '35px', borderRadius: '3px', border: '2px solid #28a745', cursor: 'zoom-in' }} 
                                                />
                                            ) : (
                                                <span style={{ fontSize: '13px', color: '#007bff', fontWeight: 'bold' }}>{course.file}</span>
                                            )}
                                            <span style={{ fontSize: '12px', color: '#28a745', fontWeight: 'bold' }}>Open file</span>
                                        </a>
                                        <button onClick={() => handleDeleteUploadedFile(course.id, course.file)} style={{ padding: '6px 10px', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Remove</button>
                                    </div>
                                )}
                            </div>

                            {/* --- INLINE UPLOADER --- */}
                            {activeUploadId === course.id && (
                                <div style={{ backgroundColor: '#f8f9fa', padding: '15px', border: '2px dashed #007bff', borderRadius: '5px', marginTop: '15px' }}>
                                    <h4 style={{ marginTop: 0 }}>Upload Course Evidence</h4>
                                    <input type="file" onChange={(e) => handleFileSelect(e, false)} />
                                    
                                    {previewUrl && (
                                        <div style={{ marginTop: '10px' }}>
                                            <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                                                <button onClick={() => setActiveTool('pen')} style={{ padding: '5px 10px', backgroundColor: activeTool === 'pen' ? '#ccc' : '#fff', border: '1px solid #aaa', borderRadius: '4px' }}>Pen</button>
                                                <button onClick={() => setActiveTool('eraser')} style={{ padding: '5px 10px', backgroundColor: activeTool === 'eraser' ? '#ccc' : '#fff', border: '1px solid #aaa', borderRadius: '4px' }}>Eraser</button>
                                                <button onClick={handleClearCanvas} style={{ padding: '5px 10px', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '4px' }}>Clear</button>
                                                <button onClick={() => clearUploadSelection(false)} style={{ padding: '5px 10px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px' }}>Remove Selected File</button>
                                            </div>
                                            <div style={{ position: 'relative', display: 'block', width: '100%', maxWidth: '820px', margin: '0 auto', border: '1px solid #000' }}>
                                                <img ref={imgRef} src={previewUrl} onLoad={handleImageLoad} style={{ width: '100%', height: 'auto', display: 'block' }} alt="Syllabus" />
                                                <canvas ref={canvasRef} onMouseDown={({ nativeEvent: { offsetX, offsetY } }) => { ctx.beginPath(); ctx.moveTo(offsetX, offsetY); ctx.lineWidth = activeTool === 'pen' ? 3 : 30; ctx.strokeStyle = 'red'; ctx.globalCompositeOperation = activeTool === 'pen' ? 'source-over' : 'destination-out'; setIsDrawing(true); }} onMouseMove={({ nativeEvent: { offsetX, offsetY } }) => { if (isDrawing) { ctx.lineTo(offsetX, offsetY); ctx.stroke(); } }} onMouseUp={() => setIsDrawing(false)} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', cursor: activeTool === 'pen' ? 'crosshair' : 'cell' }} />
                                            </div><br/>
                                            <button onClick={() => handleUploadHighlighted(false)} style={{ marginTop: '10px', padding: '8px 15px', backgroundColor: '#28a745', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 'bold', borderRadius: '4px' }}>Save Highlighted Image</button>
                                        </div>
                                    )}

                                    {rawFile && (
                                        <div style={{ marginTop: '10px', padding: '10px', backgroundColor: '#e2e3f0', borderRadius: '5px' }}>
                                            <p style={{ margin: '0 0 10px 0', fontSize: '13px', color: '#004085' }}>📄 <strong>{rawFile.name}</strong></p>
                                            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                                                <button onClick={() => handleStandardUpload(false)} style={{ padding: '8px 15px', backgroundColor: '#004085', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Attach Document</button>
                                                <button onClick={() => clearUploadSelection(false)} style={{ padding: '8px 15px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Remove Selected File</button>
                                            </div>
                                        </div>
                                    )}

                                    {uploadStatus && <p style={{ color: '#004085', fontWeight: 'bold', marginTop: '10px' }}>{uploadStatus}</p>}
                                </div>
                            )}
                        </div>
                    ))}

                    <button onClick={handleAddCourseRow} style={{ padding: '10px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', marginBottom: '20px', width: '100%' }}>+ Add another fulfilled course</button>

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ fontWeight: 'bold', color: '#004085' }}>{t('student_select_pte_courses_label')}</label>
                        <select value="" onChange={(e) => { const course = courses.find(c => c.id === parseInt(e.target.value)); if (course && !selectedCourses.find(sc => sc.id === course.id)) setSelectedCourses([...selectedCourses, course]); }} style={{ width: '100%', padding: '10px', marginTop: '5px', border: '1px solid #ccc', borderRadius: '4px' }}>
                            <option value="">{t('student_select_pte_courses_placeholder')}</option>
                            {courses.map(c => <option key={c.id} value={c.id}>{c.course_code} - {c.course_name}</option>)}
                        </select>
                        <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                            {selectedCourses.map(sc => (
                                <span key={sc.id} style={{ backgroundColor: '#17a2b8', color: 'white', padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold' }}>{sc.course_code} <button onClick={() => setSelectedCourses(selectedCourses.filter(c => c.id !== sc.id))} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', marginLeft: '5px' }}>×</button></span>
                            ))}
                        </div>
                    </div>

                    {evidenceRequiredMsg && <div style={{ backgroundColor: '#fff3cd', color: '#856404', padding: '15px', borderRadius: '5px', marginBottom: '20px' }}>{evidenceRequiredMsg}</div>}

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ fontWeight: 'bold', color: '#004085' }}>Additional Notes for Reviewer (Optional)</label>
                        <p style={{ fontSize: '12px', color: '#666', margin: '5px 0' }}>Use this space to explain complex mappings, highlight specific pages in your evidence, or provide context.</p>
                        <textarea 
                            value={studentNote}
                            onChange={(e) => setStudentNote(e.target.value)}
                            rows="4"
                            style={{ width: '100%', padding: '10px', borderRadius: '5px', border: '1px solid #ccc', boxSizing: 'border-box' }}
                            placeholder="Type any helpful context here..."
                        />
                    </div>

                    {!isSubmissionsOpen && (
                        <div style={{ backgroundColor: '#f8d7da', color: '#721c24', border: '1px solid #f5c6cb', padding: '15px', borderRadius: '5px', marginBottom: '20px' }}>
                            {t('student_submissions_closed', 'Submissions are currently closed. Please check back later.')}
                        </div>
                    )}

                    <button
                        onClick={handleSubmitApplication}
                        disabled={!isSubmissionsOpen}
                        style={{
                            width: '100%',
                            padding: '15px',
                            backgroundColor: isSubmissionsOpen ? '#004085' : '#6c757d',
                            color: 'white',
                            fontWeight: 'bold',
                            cursor: isSubmissionsOpen ? 'pointer' : 'not-allowed',
                            border: 'none',
                            borderRadius: '5px'
                        }}
                    >
                        {t('student_submit_package')}
                    </button>
                    {submitStatus && <p style={{ color: 'red', textAlign: 'center', fontWeight: 'bold', marginTop: '10px' }}>{submitStatus}</p>}
                </div>
            )}
        </div>
    );
};

export default StudentDashboard;