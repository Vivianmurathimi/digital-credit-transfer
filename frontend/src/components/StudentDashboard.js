import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';

const StudentDashboard = ({ userId }) => {
    const [courses, setCourses] = useState([]);
    const [studentTab, setStudentTab] = useState('dashboard');
    
    // --- FORM STATES ---
    const [selectedCourses, setSelectedCourses] = useState([]); 
    const [fulfilledCourse, setFulfilledCourse] = useState('');
    const [fulfilledCourseCode, setFulfilledCourseCode] = useState('');
    const [fulfilledCredits, setFulfilledCredits] = useState('');
    const [fulfilledGrade, setFulfilledGrade] = useState('');
    
    // --- UPLOAD & CANVAS STATES ---
    const [showUploader, setShowUploader] = useState(false);
    const [previewUrl, setPreviewUrl] = useState(null);
    const [uploadStatus, setUploadStatus] = useState('');
    const [uploadedFiles, setUploadedFiles] = useState([]); 
    const [submitStatus, setSubmitStatus] = useState('');
    
    // --- DASHBOARD STATES ---
    const [myApplications, setMyApplications] = useState([]); 
    const [resubmitModal, setResubmitModal] = useState({ isOpen: false, app: null });
    const [resubmitFiles, setResubmitFiles] = useState([]);
    const [isNoteExpanded, setIsNoteExpanded] = useState(false); // 🆕 For the "See More" toggle

    // --- SMART AUDITOR STATES ---
    const [evidenceRequiredMsg, setEvidenceRequiredMsg] = useState('');
    const [matches, setMatches] = useState({ name: false, credits: false });

    // --- CANVAS REFS ---
    const imgRef = useRef(null);    
    const canvasRef = useRef(null); 
    const [ctx, setCtx] = useState(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [activeTool, setActiveTool] = useState('pen'); 

    // --- FETCH DATA ---
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
        } catch (err) { console.error("Error fetching student apps", err); }
    }, [userId]);

    useEffect(() => {
        fetchCourses();
        fetchMyApplications();
    }, [fetchCourses, fetchMyApplications]);

    // --- SMART AUDITOR LOGIC ---
    useEffect(() => {
        if (selectedCourses.length > 0 && fulfilledCourse) {
            const totalTargetCredits = selectedCourses.reduce((sum, c) => sum + parseFloat(c.credits || 0), 0);
            const inputCredits = parseFloat(fulfilledCredits || 0);
            const creditMatch = inputCredits >= totalTargetCredits;
            
            let nameMatch = false;
            if (selectedCourses.length === 1) {
                const targetName = selectedCourses[0].course_name.toLowerCase();
                const fulfilledName = fulfilledCourse.toLowerCase();
                nameMatch = fulfilledName.includes(targetName) || targetName.includes(fulfilledName);
            }

            setMatches({ name: nameMatch, credits: creditMatch });

            if (!creditMatch || !nameMatch || selectedCourses.length > 1) {
                let reason = selectedCourses.length > 1 ? "mapping a package of multiple courses" : (!creditMatch ? `the credit gap` : "the course name difference");
                setEvidenceRequiredMsg(`Please attach proof of fulfilling this coursework (syllabus) to account for ${reason}.`);
            } else setEvidenceRequiredMsg('');
        } else {
            setMatches({ name: false, credits: false });
            setEvidenceRequiredMsg('');
        }
    }, [fulfilledCourse, selectedCourses, fulfilledCredits]);

    // --- CANVAS METHODS ---
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

    const handleUploadHighlighted = () => {
        if (!canvasRef.current || !imgRef.current) return;
        setUploadStatus('⏳ Saving evidence...');
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvasRef.current.width; 
        tempCanvas.height = canvasRef.current.height;
        const tempCtx = tempCanvas.getContext('2d');
        
        tempCtx.drawImage(imgRef.current, 0, 0, tempCanvas.width, tempCanvas.height);
        tempCtx.drawImage(canvasRef.current, 0, 0);
        
        tempCanvas.toBlob(async (blob) => {
            const formData = new FormData(); 
            formData.append('file', blob, `marked-${Date.now()}.png`);
            try {
                const res = await axios.post('/api/upload', formData);
                if (res.data.success) {
                    setUploadStatus(`✅ Evidence saved.`);
                    setUploadedFiles(prev => [...prev, res.data.fileName]);
                    setTimeout(() => { setShowUploader(false); setUploadStatus(''); setPreviewUrl(null); }, 1500);
                }
            } catch (err) { setUploadStatus('❌ Upload failed.'); }
        }, 'image/png'); 
    };

    const handleDeleteFile = async (fileNameToRemove) => {
        try {
            await axios.delete(`/api/upload/${fileNameToRemove}`);
            setUploadedFiles(prev => prev.filter(f => f !== fileNameToRemove));
        } catch (err) { alert("Failed to delete file."); }
    };

    // --- SUBMISSION METHODS ---
    const handleSubmitApplication = async () => {
        if (!fulfilledCourse || selectedCourses.length === 0 || uploadedFiles.length === 0) {
            return setSubmitStatus('❌ Complete all fields and upload evidence.');
        }
        try {
            setSubmitStatus('⏳ Submitting request...');
            const targetCourseNames = selectedCourses.map(c => `${c.course_code} (${c.course_name})`).join(' + ');

            const response = await axios.post('/api/applications', {
                student_id: userId, 
                previous_course: fulfilledCourse, 
                fulfilled_course_code: fulfilledCourseCode,
                fulfilled_credits: fulfilledCredits, 
                fulfilled_grade: fulfilledGrade, 
                pte_course_names: targetCourseNames, 
                syllabus_file: uploadedFiles.join(','), 
                system_note: evidenceRequiredMsg
            });
            
            if (response.data.success) {
                alert(`🎉 Submitted successfully!`);
                setFulfilledCourse(''); setFulfilledCourseCode(''); setFulfilledCredits(''); setFulfilledGrade('');
                setSelectedCourses([]); setShowUploader(false); setUploadedFiles([]); setPreviewUrl(null); setSubmitStatus('');
                fetchMyApplications(); 
                setStudentTab('dashboard');
            }
        } catch (err) { setSubmitStatus('❌ Submission failed.'); }
    };

    const handleResubmitFileUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        setUploadStatus('⏳ Uploading missing proof...');
        const formData = new FormData();
        formData.append('file', file, `extra-proof-${Date.now()}.png`);
        try {
            const res = await axios.post('/api/upload', formData);
            if (res.data.success) {
                setResubmitFiles(prev => [...prev, res.data.fileName]);
                setUploadStatus('✅ Missing file attached ready to send!');
            }
        } catch (err) { setUploadStatus('❌ Upload failed.'); }
    };

    const submitResubmission = async () => {
        if (resubmitFiles.length === 0) return alert("Please attach the requested missing information before resubmitting.");
        try {
            setUploadStatus('⏳ Sending back to reviewer...');
            const res = await axios.put(`/api/applications/${resubmitModal.app.id}/resubmit`, { new_files: resubmitFiles.join(',') });
            if (res.data.success) {
                alert("🎉 Successfully returned to Reviewer!");
                setResubmitModal({ isOpen: false, app: null });
                setIsNoteExpanded(false); // Reset toggle
                setResubmitFiles([]); 
                setUploadStatus(''); 
                fetchMyApplications(); 
            }
        } catch (err) { setUploadStatus('❌ Failed to resubmit.'); }
    };

    return (
        <div style={{ marginTop: '10px' }}>
            {/* TABS */}
            <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                <button onClick={() => setStudentTab('dashboard')} style={{ padding: '10px 20px', cursor: 'pointer', border: 'none', borderRadius: '5px', fontWeight: 'bold', backgroundColor: studentTab === 'dashboard' ? '#004085' : '#e2e3f0', color: studentTab === 'dashboard' ? 'white' : '#004085' }}>📊 My Status</button>
                <button onClick={() => setStudentTab('submit')} style={{ padding: '10px 20px', cursor: 'pointer', border: 'none', borderRadius: '5px', fontWeight: 'bold', backgroundColor: studentTab === 'submit' ? '#004085' : '#e2e3f0', color: studentTab === 'submit' ? 'white' : '#004085' }}>➕ New Application</button>
            </div>

            {/* MY STATUS DASHBOARD */}
            {studentTab === 'dashboard' && (
                <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '10px', border: '1px solid #ccc' }}>
                    <h2 style={{ marginTop: 0, color: '#004085' }}>📜 My Applications</h2>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ backgroundColor: '#f8f9fa' }}>
                                <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Fulfilled Course</th>
                                <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Target PTE Courses</th>
                                <th style={{ padding: '12px', textAlign: 'center', borderBottom: '2px solid #ddd' }}>Status</th>
                                <th style={{ padding: '12px', textAlign: 'center', borderBottom: '2px solid #ddd' }}>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {myApplications.length === 0 ? (
                                <tr><td colSpan="4" style={{ textAlign: 'center', padding: '20px' }}>No applications submitted yet.</td></tr>
                            ) : myApplications.map(app => (
                                <tr key={app.id} style={{ borderBottom: '1px solid #eee' }}>
                                    <td style={{ padding: '12px', fontWeight: 'bold', verticalAlign: 'top' }}>{app.fulfilled_course}</td>
                                    
                                    {/* Mapped Courses Bulleted List */}
                                    <td style={{ padding: '12px', color: '#004085', verticalAlign: 'top' }}>
                                        <ul style={{ margin: 0, paddingLeft: '15px', listStyleType: 'disc' }}>
                                            {app.pte_course_names ? app.pte_course_names.split(' + ').map((courseName, idx) => (
                                                <li key={idx} style={{ marginBottom: '5px' }}>{courseName}</li>
                                            )) : <li>No courses listed</li>}
                                        </ul>
                                    </td>
                                    
                                    <td style={{ padding: '12px', textAlign: 'center', verticalAlign: 'top' }}>
                                        <span style={{ fontWeight: 'bold', padding: '5px 10px', borderRadius: '15px', color: 'white', fontSize: '11px', backgroundColor: app.status === 'approved' ? '#28a745' : app.status === 'rejected' ? '#dc3545' : app.status === 'needs_info' ? '#fd7e14' : '#007bff' }}>
                                            {app.status.toUpperCase()}
                                        </span>
                                    </td>
                                    <td style={{ padding: '12px', textAlign: 'center', verticalAlign: 'top' }}>
                                        {app.status === 'needs_info' ? (
                                            <button onClick={() => setResubmitModal({ isOpen: true, app: app })} style={{ padding: '6px 12px', backgroundColor: '#fd7e14', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>✏️ Add Missing Info</button>
                                        ) : <span style={{ color: '#666', fontSize: '14px' }}>🔒 Locked</span>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* RESUBMIT MODAL WITH "SEE MORE" */}
            {resubmitModal.isOpen && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
                    <div style={{ backgroundColor: '#fff', padding: '25px', borderRadius: '10px', width: '500px', boxShadow: '0 5px 15px rgba(0,0,0,0.3)' }}>
                        <h3 style={{ marginTop: 0, color: '#fd7e14' }}>⚠️ Action Required</h3>
                        
                        <div style={{ backgroundColor: '#fff3cd', padding: '15px', borderRadius: '5px', marginBottom: '15px', borderLeft: '5px solid #fd7e14' }}>
                            <strong style={{ color: '#856404' }}>Reviewer Note:</strong>
                            <p style={{ margin: '5px 0 0 0', color: '#555', fontStyle: 'italic', wordBreak: 'break-word' }}>
                                "{resubmitModal.app.reviewer_note.length > 150 && !isNoteExpanded 
                                    ? resubmitModal.app.reviewer_note.substring(0, 150) + '...' 
                                    : resubmitModal.app.reviewer_note}"
                                
                                {resubmitModal.app.reviewer_note.length > 150 && (
                                    <button 
                                        onClick={() => setIsNoteExpanded(!isNoteExpanded)} 
                                        style={{ background: 'none', border: 'none', color: '#007bff', cursor: 'pointer', fontWeight: 'bold', padding: '0 5px', fontSize: '13px' }}
                                    >
                                        {isNoteExpanded ? 'See Less' : 'See More'}
                                    </button>
                                )}
                            </p>
                        </div>

                        <input type="file" onChange={handleResubmitFileUpload} style={{ marginBottom: '15px' }} />
                        {uploadStatus && <p style={{ color: '#004085', fontWeight: 'bold', marginBottom: '10px' }}>{uploadStatus}</p>}
                        
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                            <button onClick={() => { setResubmitModal({ isOpen: false, app: null }); setIsNoteExpanded(false); setUploadStatus(''); }} style={{ padding: '10px 15px', cursor: 'pointer', border: '1px solid #ccc', borderRadius: '4px' }}>Cancel</button>
                            <button onClick={submitResubmission} style={{ padding: '10px 15px', cursor: 'pointer', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>📤 Resubmit</button>
                        </div>
                    </div>
                </div>
            )}

            {/* NEW APPLICATION TAB */}
            {studentTab === 'submit' && (
                <div style={{ backgroundColor: '#e2e3f0', padding: '20px', borderRadius: '10px', border: '1px solid #b8daff', maxWidth: '800px' }}>
                    <h2 style={{ marginTop: 0, color: '#004085' }}>🎓 New Package Application</h2>
                    
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', backgroundColor: '#fff', padding: '15px', borderRadius: '5px', marginBottom: '20px' }}>
                        <div><label style={{ fontSize: '12px', fontWeight: 'bold' }}>Fulfilled Course Name {matches.name && <span style={{ color: 'green' }}>✅</span>}</label><input type="text" value={fulfilledCourse} onChange={(e) => setFulfilledCourse(e.target.value)} style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }} /></div>
                        <div><label style={{ fontSize: '12px', fontWeight: 'bold' }}>Course Code</label><input type="text" value={fulfilledCourseCode} onChange={(e) => setFulfilledCourseCode(e.target.value)} style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }} /></div>
                        <div><label style={{ fontSize: '12px', fontWeight: 'bold' }}>Total Credits {matches.credits && <span style={{ color: 'green' }}>✅</span>}</label><input type="number" step="0.5" value={fulfilledCredits} onChange={(e) => setFulfilledCredits(e.target.value)} style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }} /></div>
                        <div><label style={{ fontSize: '12px', fontWeight: 'bold' }}>Grade</label><input type="text" value={fulfilledGrade} onChange={(e) => setFulfilledGrade(e.target.value)} style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }} /></div>
                    </div>
                    
                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ fontWeight: 'bold', color: '#004085' }}>Select Target PTE Courses (Build your package):</label>
                        <select value="" onChange={(e) => {
                                const course = courses.find(c => c.id === parseInt(e.target.value));
                                if (course && !selectedCourses.find(sc => sc.id === course.id)) setSelectedCourses([...selectedCourses, course]);
                            }} style={{ width: '100%', padding: '10px', marginTop: '5px', border: '1px solid #ccc', borderRadius: '4px' }}>
                            <option value="">-- Select & Add PTE Courses --</option>
                            {courses.map(c => <option key={c.id} value={c.id}>{c.course_code} - {c.course_name}</option>)}
                        </select>
                        <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                            {selectedCourses.map(sc => (
                                <span key={sc.id} style={{ backgroundColor: '#28a745', color: 'white', padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold' }}>
                                    {sc.course_code} <button onClick={() => setSelectedCourses(selectedCourses.filter(c => c.id !== sc.id))} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', marginLeft: '5px' }}>×</button>
                                </span>
                            ))}
                        </div>
                    </div>

                    {evidenceRequiredMsg && (
                        <div style={{ backgroundColor: '#d1ecf1', color: '#0c5460', padding: '15px', borderRadius: '5px', marginBottom: '20px', border: '1px solid #bee5eb' }}><strong>ℹ️ Notice:</strong> {evidenceRequiredMsg}</div>
                    )}

                    {/* ATTACHED EVIDENCE */}
                    {uploadedFiles.length > 0 && (
                        <div style={{ marginBottom: '15px' }}>
                            <label style={{ fontWeight: 'bold', color: '#004085' }}>Attached Evidence ({uploadedFiles.length}):</label>
                            <div style={{ display: 'flex', gap: '15px', marginTop: '10px', flexWrap: 'wrap' }}>
                                {uploadedFiles.map((file, index) => (
                                    <div key={index} style={{ position: 'relative' }}>
                                        <img src={`http://localhost:5000/transcripts/${file}`} alt="Proof" onClick={() => window.open(`http://localhost:5000/transcripts/${file}`)} style={{ height: '80px', borderRadius: '3px', cursor: 'pointer', border: '2px solid #004085' }} />
                                        <button onClick={() => handleDeleteFile(file)} style={{ position: 'absolute', top: '-10px', right: '-10px', backgroundColor: 'red', color: 'white', border: 'none', borderRadius: '50%', cursor: 'pointer', width: '25px', height: '25px', fontWeight: 'bold', boxShadow: '0 2px 4px rgba(0,0,0,0.2)' }}>×</button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <button onClick={() => setShowUploader(!showUploader)} style={{ marginBottom: '10px', padding: '10px', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>
                        {showUploader ? 'Hide Uploader' : '📸 Upload Evidence'}
                    </button>
                    
                    {/* HIGHLIGHTER CANVAS */}
                    {showUploader && (
                        <div style={{ backgroundColor: '#fff', padding: '15px', border: '2px dashed #007bff', borderRadius: '5px', marginBottom: '20px' }}>
                            <input type="file" onChange={(e) => setPreviewUrl(URL.createObjectURL(e.target.files[0]))} />
                            {previewUrl && (
                                <div style={{ marginTop: '10px' }}>
                                    <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                                        <button onClick={() => setActiveTool('pen')} style={{ padding: '5px 10px', cursor: 'pointer', backgroundColor: activeTool === 'pen' ? '#ccc' : '#f8f9fa', border: '1px solid #aaa', borderRadius: '4px' }}>🔴 Pen</button>
                                        <button onClick={() => setActiveTool('eraser')} style={{ padding: '5px 10px', cursor: 'pointer', backgroundColor: activeTool === 'eraser' ? '#ccc' : '#f8f9fa', border: '1px solid #aaa', borderRadius: '4px' }}>🧹 Eraser</button>
                                        <button onClick={handleClearCanvas} style={{ padding: '5px 10px', cursor: 'pointer', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '4px' }}>🗑️ Clear</button>
                                    </div>
                                    <div style={{ position: 'relative', display: 'inline-block', border: '1px solid #000' }}>
                                        <img ref={imgRef} src={previewUrl} onLoad={handleImageLoad} style={{ maxWidth: '100%' }} alt="Syllabus" />
                                        <canvas 
                                            ref={canvasRef} 
                                            onMouseDown={({ nativeEvent: { offsetX, offsetY } }) => { ctx.beginPath(); ctx.moveTo(offsetX, offsetY); ctx.lineWidth = activeTool === 'pen' ? 3 : 30; ctx.strokeStyle = 'red'; ctx.globalCompositeOperation = activeTool === 'pen' ? 'source-over' : 'destination-out'; setIsDrawing(true); }} 
                                            onMouseMove={({ nativeEvent: { offsetX, offsetY } }) => { if (isDrawing) { ctx.lineTo(offsetX, offsetY); ctx.stroke(); } }} 
                                            onMouseUp={() => setIsDrawing(false)} 
                                            style={{ position: 'absolute', top: 0, left: 0, cursor: activeTool === 'pen' ? 'crosshair' : 'cell' }} 
                                        />
                                    </div><br/>
                                    <button onClick={handleUploadHighlighted} style={{ marginTop: '10px', padding: '8px 15px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>💾 Save Page</button>
                                    {uploadStatus && <span style={{ marginLeft: '15px', fontWeight: 'bold', color: '#004085' }}>{uploadStatus}</span>}
                                </div>
                            )}
                        </div>
                    )}

                    <button onClick={handleSubmitApplication} style={{ width: '100%', padding: '15px', backgroundColor: '#004085', color: 'white', fontWeight: 'bold', cursor: 'pointer', border: 'none', borderRadius: '5px' }}>🚀 Submit Package Request</button>
                    {submitStatus && <p style={{ color: 'red', textAlign: 'center', fontWeight: 'bold', marginTop: '10px' }}>{submitStatus}</p>}
                </div>
            )}
        </div>
    );
};

export default StudentDashboard;