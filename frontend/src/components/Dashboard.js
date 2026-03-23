import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';

const Dashboard = () => {
    const navigate = useNavigate();
    const role = localStorage.getItem('role');
    const token = localStorage.getItem('token');
    const userId = token ? JSON.parse(atob(token.split('.')[1])).id : null;
    
    // --- COMMON STATES ---
    const [courses, setCourses] = useState([]);
    const [applications, setApplications] = useState([]); 

    // --- STUDENT STATES ---
    const [studentTab, setStudentTab] = useState('dashboard');
    const [selectedCourses, setSelectedCourses] = useState([]); 
    const [fulfilledCourse, setFulfilledCourse] = useState('');
    const [fulfilledCourseCode, setFulfilledCourseCode] = useState('');
    const [fulfilledCredits, setFulfilledCredits] = useState('');
    const [fulfilledGrade, setFulfilledGrade] = useState('');
    
    const [showUploader, setShowUploader] = useState(false);
    const [previewUrl, setPreviewUrl] = useState(null);
    const [uploadStatus, setUploadStatus] = useState('');
    const [uploadedFiles, setUploadedFiles] = useState([]); 
    const [submitStatus, setSubmitStatus] = useState('');
    const [myApplications, setMyApplications] = useState([]); 

    // --- RESUBMIT STATES (The Pending Loop) ---
    const [resubmitModal, setResubmitModal] = useState({ isOpen: false, app: null });
    const [resubmitFiles, setResubmitFiles] = useState([]);

    // --- AUDITOR STATES ---
    const [evidenceRequiredMsg, setEvidenceRequiredMsg] = useState('');
    const [matches, setMatches] = useState({ name: false, credits: false });

    // --- REVIEWER STATES ---
    const [reviewerTab, setReviewerTab] = useState('pending');
    const [feedbackModal, setFeedbackModal] = useState({ isOpen: false, appId: null, type: '' });
    const [reviewerNote, setReviewerNote] = useState('');
    const [feedbackUploadStatus, setFeedbackUploadStatus] = useState('');

    // --- CANVAS STATES ---
    const imgRef = useRef(null);    
    const canvasRef = useRef(null); 
    const [ctx, setCtx] = useState(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [activeTool, setActiveTool] = useState('pen'); 

    // --- DATA FETCHING ---
    const fetchCourses = useCallback(async () => {
        try {
            const res = await axios.get('/api/pte-courses');
            if (res.data.success) setCourses(res.data.courses); 
        } catch (err) { console.error(err); }
    }, []);

    const fetchApplications = useCallback(async () => {
        try {
            const res = await axios.get('/api/applications');
            if (res.data.success) setApplications(res.data.applications);
        } catch (err) { console.error("Error fetching apps", err); }
    }, []);

    const fetchMyApplications = useCallback(async () => {
        if (!userId) return;
        try {
            const res = await axios.get(`/api/applications/student/${userId}`);
            if (res.data.success) setMyApplications(res.data.applications);
        } catch (err) { console.error("Error fetching student apps", err); }
    }, [userId]);

    useEffect(() => {
        if (role === 'student') { fetchCourses(); fetchMyApplications(); }
        if (role === 'reviewer' || role === 'superadmin') { fetchApplications(); }
    }, [role, fetchCourses, fetchApplications, fetchMyApplications]);

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
                let reason = selectedCourses.length > 1 ? "mapping one course to multiple target courses" : (!creditMatch ? `the credit gap` : "the course name difference");
                setEvidenceRequiredMsg(`Please attach proof of fulfilling this course (syllabus) to account for ${reason}.`);
            } else setEvidenceRequiredMsg('');
        } else {
            setMatches({ name: false, credits: false });
            setEvidenceRequiredMsg('');
        }
    }, [fulfilledCourse, selectedCourses, fulfilledCredits]);

    // --- ACTIONS ---
    const handleLogout = () => { localStorage.clear(); navigate('/login'); };

    const handleImpersonate = (newRole) => {
        localStorage.setItem('originalRole', 'superadmin');
        localStorage.setItem('role', newRole);
        window.location.reload();
    };

    const stopImpersonation = () => {
        const original = localStorage.getItem('originalRole');
        if (original) {
            localStorage.setItem('role', original);
            localStorage.removeItem('originalRole');
            window.location.reload();
        }
    };

    const handleUpdateStatus = async (appId, newStatus) => {
        try {
            const res = await axios.put(`/api/applications/${appId}/status`, { status: newStatus, note: 'System Override' });
            if (res.data.success) { alert(`Status updated to ${newStatus}!`); fetchApplications(); }
        } catch (err) { alert("Update failed."); }
    };

    const handleDownload = async (fileName) => {
        try {
            const response = await fetch(`http://localhost:9000/transcripts/${fileName}`);
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url; link.download = fileName; 
            document.body.appendChild(link); link.click(); document.body.removeChild(link);
        } catch (err) { alert("Download failed."); }
    };

    // --- REVIEWER DECISION & FEEDBACK LOGIC ---
    const submitReviewerDecision = async () => {
        if (!reviewerNote.trim() && feedbackModal.type !== 'approved') return alert("A rationale note is mandatory.");
        try {
            setFeedbackUploadStatus('⏳ Submitting decision...');
            const res = await axios.put(`/api/applications/${feedbackModal.appId}/status`, { status: feedbackModal.type, note: reviewerNote });
            if (res.data.success) {
                alert(`Application marked as ${feedbackModal.type.toUpperCase()}`);
                setFeedbackModal({ isOpen: false, appId: null, type: '' });
                setReviewerNote(''); setFeedbackUploadStatus(''); fetchApplications(); 
            }
        } catch (err) { setFeedbackUploadStatus('❌ Failed to save decision.'); }
    };

    // --- STUDENT UPLOAD & SUBMIT LOGIC ---
    const handleImageLoad = () => {
        if (imgRef.current && canvasRef.current) {
            const canvas = canvasRef.current;
            canvas.width = imgRef.current.clientWidth; canvas.height = imgRef.current.clientHeight;
            const context = canvas.getContext('2d'); context.lineCap = 'round'; setCtx(context);
        }
    };

    const handleUploadHighlighted = () => {
        if (!canvasRef.current || !imgRef.current) return;
        setUploadStatus('⏳ Saving...');
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvasRef.current.width; tempCanvas.height = canvasRef.current.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(imgRef.current, 0, 0, tempCanvas.width, tempCanvas.height);
        tempCtx.drawImage(canvasRef.current, 0, 0);
        
        tempCanvas.toBlob(async (blob) => {
            const formData = new FormData(); formData.append('file', blob, `marked-${Date.now()}.png`);
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

    const handleSubmitApplication = async () => {
        if (!fulfilledCourse || selectedCourses.length === 0 || uploadedFiles.length === 0) {
            return setSubmitStatus('❌ Complete all fields and upload evidence.');
        }
        try {
            setSubmitStatus('⏳ Submitting request...');
            const response = await axios.post('/api/applications', {
                student_id: userId, previous_course: fulfilledCourse, fulfilled_course_code: fulfilledCourseCode,
                fulfilled_credits: fulfilledCredits, fulfilled_grade: fulfilledGrade, pte_course_ids: selectedCourses.map(c => c.id), 
                syllabus_file: uploadedFiles.join(','), system_note: evidenceRequiredMsg
            });
            if (response.data.success) {
                alert(`🎉 Submitted successfully!`);
                setFulfilledCourse(''); setFulfilledCourseCode(''); setFulfilledCredits(''); setFulfilledGrade('');
                setSelectedCourses([]); setShowUploader(false); setUploadedFiles([]); setPreviewUrl(null); setSubmitStatus('');
                fetchMyApplications(); setStudentTab('dashboard');
            }
        } catch (err) { setSubmitStatus('❌ Submission failed.'); }
    };

    // --- RESUBMIT LOGIC (Pending Loop) ---
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
            const res = await axios.put(`/api/applications/${resubmitModal.app.id}/resubmit`, {
                new_files: resubmitFiles.join(',')
            });
            if (res.data.success) {
                alert("🎉 Successfully returned to Reviewer!");
                setResubmitModal({ isOpen: false, app: null });
                setResubmitFiles([]); setUploadStatus('');
                fetchMyApplications(); 
            }
        } catch (err) { setUploadStatus('❌ Failed to resubmit.'); }
    };

    // --- REVIEWER TAB FILTERING ---
    const pendingApps = applications.filter(a => a.status === 'pending');
    const needsInfoApps = applications.filter(a => a.status === 'needs_info');
    const completedApps = applications.filter(a => a.status === 'approved' || a.status === 'rejected');
    const activeReviewerApps = reviewerTab === 'pending' ? pendingApps : reviewerTab === 'needs_info' ? needsInfoApps : completedApps;

    return (
        <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto', fontFamily: 'sans-serif' }}>
            
            {/* SAFETY BANNER */}
            {localStorage.getItem('originalRole') && (
                <div style={{ backgroundColor: '#ffc107', padding: '15px', textAlign: 'center', fontWeight: 'bold', marginBottom: '20px', borderRadius: '8px' }}>
                    ⚠️ VIEWING AS {role.toUpperCase()}
                    <button onClick={stopImpersonation} style={{ marginLeft: '20px', cursor: 'pointer', padding: '5px 10px', fontWeight: 'bold' }}>Return to Admin</button>
                </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #ddd', paddingBottom: '10px' }}>
                <h1 style={{ color: '#003d7c', margin: 0 }}>University Portal</h1>
                <button onClick={handleLogout} style={{ padding: '10px 15px', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>Log Out</button>
            </div>

            {/* --- SUPER ADMIN VIEW --- */}
            {role === 'superadmin' && !localStorage.getItem('originalRole') && (
                <div style={{ marginTop: '30px' }}>
                    <div style={{ backgroundColor: '#f8f9fa', padding: '20px', borderRadius: '10px', textAlign: 'center', marginBottom: '30px' }}>
                        <h3 style={{ marginTop: 0 }}>👤 Audit Controls</h3>
                        <button onClick={() => handleImpersonate('student')} style={{ padding: '10px 20px', marginRight: '10px', cursor: 'pointer', backgroundColor: '#004085', color: 'white', border: 'none', borderRadius: '4px' }}>Audit as Student</button>
                        <button onClick={() => handleImpersonate('reviewer')} style={{ padding: '10px 20px', cursor: 'pointer', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px' }}>Audit as Reviewer</button>
                    </div>

                    <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '10px', border: '1px solid #003d7c' }}>
                        <h2 style={{ marginTop: 0, color: '#003d7c' }}>🛡️ Admin Overrides</h2>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={{ backgroundColor: '#003d7c', color: 'white' }}>
                                    <th style={{ padding: '12px', textAlign: 'left' }}>Student</th>
                                    <th style={{ padding: '12px', textAlign: 'center' }}>Status</th>
                                    <th style={{ padding: '12px', textAlign: 'center' }}>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {applications.map(app => (
                                    <tr key={app.id} style={{ borderBottom: '1px solid #eee' }}>
                                        <td style={{ padding: '12px' }}>{app.student_name}</td>
                                        <td style={{ padding: '12px', textAlign: 'center' }}><span style={{ fontWeight: 'bold', color: app.status === 'approved' ? 'green' : app.status === 'rejected' ? 'red' : 'orange' }}>{app.status.toUpperCase()}</span></td>
                                        <td style={{ padding: '12px', textAlign: 'center' }}>
                                            <button onClick={() => handleUpdateStatus(app.id, 'pending')} style={{ cursor: 'pointer', padding: '5px 10px', backgroundColor: '#ffc107', border: 'none', borderRadius: '3px' }}>🔄 Reset</button>
                                            <button onClick={() => handleUpdateStatus(app.id, 'approved')} style={{ cursor: 'pointer', marginLeft: '5px', padding: '5px 10px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '3px' }}>🚀 Force Approve</button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* --- REVIEWER VIEW --- */}
            {role === 'reviewer' && (
                <div style={{ marginTop: '30px', backgroundColor: '#e2f0d9', padding: '20px', borderRadius: '10px' }}>
                    <h2 style={{ marginTop: 0, color: '#155724' }}>👨‍🏫 Administrative Review Board</h2>
                    
                    <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '2px solid #c3e6cb', paddingBottom: '10px' }}>
                        <button onClick={() => setReviewerTab('pending')} style={{ padding: '10px 20px', cursor: 'pointer', border: 'none', borderRadius: '20px', fontWeight: 'bold', backgroundColor: reviewerTab === 'pending' ? '#fff' : 'transparent', color: '#155724' }}>🟡 Pending Review <span style={{ backgroundColor: '#ffc107', color: '#000', padding: '2px 8px', borderRadius: '10px', marginLeft: '5px' }}>{pendingApps.length}</span></button>
                        <button onClick={() => setReviewerTab('needs_info')} style={{ padding: '10px 20px', cursor: 'pointer', border: 'none', borderRadius: '20px', fontWeight: 'bold', backgroundColor: reviewerTab === 'needs_info' ? '#fff' : 'transparent', color: '#155724' }}>🟠 Pending (Need Info) <span style={{ backgroundColor: '#fd7e14', color: '#fff', padding: '2px 8px', borderRadius: '10px', marginLeft: '5px' }}>{needsInfoApps.length}</span></button>
                        <button onClick={() => setReviewerTab('completed')} style={{ padding: '10px 20px', cursor: 'pointer', border: 'none', borderRadius: '20px', fontWeight: 'bold', backgroundColor: reviewerTab === 'completed' ? '#fff' : 'transparent', color: '#155724' }}>✅ Completed <span style={{ backgroundColor: '#28a745', color: '#fff', padding: '2px 8px', borderRadius: '10px', marginLeft: '5px' }}>{completedApps.length}</span></button>
                    </div>

                    <table style={{ width: '100%', borderCollapse: 'collapse', backgroundColor: '#fff' }}>
                        <thead>
                            <tr style={{ backgroundColor: '#28a745', color: 'white' }}>
                                {/* Clean 5-Column Layout */}
                                <th style={{ padding: '10px', textAlign: 'left' }}>Student</th>
                                <th style={{ padding: '10px', textAlign: 'left' }}>Fulfilled Course</th>
                                <th style={{ padding: '10px', textAlign: 'left' }}>Target Course</th>
                                <th style={{ padding: '10px', textAlign: 'center' }}>Evidence</th>
                                <th style={{ padding: '10px', textAlign: 'center' }}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {activeReviewerApps.length === 0 ? (
                                <tr><td colSpan="5" style={{ textAlign: 'center', padding: '20px' }}>No applications in this category.</td></tr>
                            ) : activeReviewerApps.map(app => (
                                <tr key={app.id} style={{ borderBottom: '1px solid #eee' }}>
                                    
                                    <td style={{ padding: '10px' }}><strong>{app.student_name}</strong></td>
                                    <td style={{ padding: '10px', fontWeight: 'bold', color: '#004085' }}>{app.fulfilled_course}</td>
                                    <td style={{ padding: '10px' }}>{app.pte_course_name}</td>
                                    
                                   <td style={{ padding: '10px', textAlign: 'center' }}>
    <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
        {app.syllabus_file && app.syllabus_file.split(',').map((file, idx) => (
            <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '5px', alignItems: 'center', border: '1px solid #ddd', padding: '5px', borderRadius: '6px', backgroundColor: '#f8f9fa', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                
                {/* 📸 The Clickable Image */}
                <img 
                    src={`http://localhost:9000/transcripts/${file}`} 
                    alt={`Proof ${idx+1}`} 
                    onClick={() => window.open(`http://localhost:9000/transcripts/${file}`, '_blank')}
                    title="Click to view full size"
                    style={{ 
                        width: '50px', height: '50px', objectFit: 'cover', border: '1px solid #ccc', 
                        borderRadius: '4px', cursor: 'pointer' 
                    }} 
                />
                
                {/* 📥 The Download Button */}
                <button 
                    onClick={() => handleDownload(file)} 
                    title="Download File" 
                    style={{ cursor: 'pointer', fontSize: '11px', padding: '3px 0', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '3px', width: '100%', fontWeight: 'bold' }}
                >
                    📥
                </button>
            </div>
        ))}
    </div>
</td>
                                    <td style={{ padding: '10px', textAlign: 'center' }}>
                                        {reviewerTab !== 'completed' ? (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                                                <button onClick={() => setFeedbackModal({ isOpen: true, appId: app.id, type: 'approved' })} style={{ backgroundColor: '#28a745', color: 'white', cursor: 'pointer', padding: '6px', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>✅ Approve</button>
                                                <button onClick={() => setFeedbackModal({ isOpen: true, appId: app.id, type: 'needs_info' })} style={{ backgroundColor: '#fd7e14', color: 'white', cursor: 'pointer', padding: '6px', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>🟠 Request Info</button>
                                                <button onClick={() => setFeedbackModal({ isOpen: true, appId: app.id, type: 'rejected' })} style={{ backgroundColor: '#dc3545', color: 'white', cursor: 'pointer', padding: '6px', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>❌ Reject</button>
                                            </div>
                                        ) : (
                                            <div>
                                                <strong style={{ color: app.status === 'approved' ? 'green' : 'red' }}>{app.status.toUpperCase()}</strong>
                                                <div style={{ fontSize: '11px', color: '#555', marginTop: '5px', fontStyle: 'italic' }}>"{app.reviewer_note}"</div>
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    {/* REVIEWER RATIONALE MODAL */}
                    {feedbackModal.isOpen && (
                        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
                            <div style={{ backgroundColor: '#fff', padding: '25px', borderRadius: '10px', width: '400px', boxShadow: '0 5px 15px rgba(0,0,0,0.3)' }}>
                                <h3 style={{ marginTop: 0, color: feedbackModal.type === 'needs_info' ? '#fd7e14' : '#003d7c' }}>{feedbackModal.type === 'needs_info' ? 'Request Information' : `Confirm ${feedbackModal.type.toUpperCase()}`}</h3>
                                <label style={{ fontWeight: 'bold', fontSize: '14px' }}>Mandatory Rationale Note:</label>
                                <textarea value={reviewerNote} onChange={(e) => setReviewerNote(e.target.value)} placeholder="Explain your decision or exactly what the student needs to fix/upload..." style={{ width: '100%', height: '100px', marginTop: '8px', padding: '10px', boxSizing: 'border-box', border: '1px solid #ccc', borderRadius: '4px', resize: 'vertical' }} />
                                {feedbackUploadStatus && <p style={{ color: '#004085', fontWeight: 'bold', marginTop: '10px' }}>{feedbackUploadStatus}</p>}
                                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                                    <button onClick={() => { setFeedbackModal({ isOpen: false }); setReviewerNote(''); }} style={{ padding: '8px 15px', cursor: 'pointer', border: '1px solid #ccc', borderRadius: '4px', backgroundColor: '#f8f9fa', fontWeight: 'bold' }}>Cancel</button>
                                    <button onClick={submitReviewerDecision} style={{ padding: '8px 15px', cursor: 'pointer', backgroundColor: '#004085', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>Submit Decision</button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* --- STUDENT VIEW --- */}
            {role === 'student' && (
                <div style={{ marginTop: '30px' }}>
                    <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                        <button onClick={() => setStudentTab('dashboard')} style={{ padding: '10px 20px', cursor: 'pointer', border: 'none', borderRadius: '5px', fontWeight: 'bold', backgroundColor: studentTab === 'dashboard' ? '#004085' : '#e2e3f0', color: studentTab === 'dashboard' ? 'white' : '#004085' }}>📊 My Status</button>
                        <button onClick={() => setStudentTab('submit')} style={{ padding: '10px 20px', cursor: 'pointer', border: 'none', borderRadius: '5px', fontWeight: 'bold', backgroundColor: studentTab === 'submit' ? '#004085' : '#e2e3f0', color: studentTab === 'submit' ? 'white' : '#004085' }}>➕ New Application</button>
                    </div>

                    {studentTab === 'dashboard' && (
                        <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '10px', border: '1px solid #ccc' }}>
                            <h2 style={{ marginTop: 0, color: '#004085' }}>📜 My Applications</h2>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ backgroundColor: '#f8f9fa' }}>
                                        <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Fulfilled Course</th>
                                        <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Target PTE Course</th>
                                        <th style={{ padding: '12px', textAlign: 'center', borderBottom: '2px solid #ddd' }}>Status</th>
                                        <th style={{ padding: '12px', textAlign: 'center', borderBottom: '2px solid #ddd' }}>Action / Lock Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {myApplications.length === 0 ? (
                                        <tr><td colSpan="4" style={{ textAlign: 'center', padding: '20px' }}>No applications submitted yet.</td></tr>
                                    ) : myApplications.map(app => (
                                        <tr key={app.id} style={{ borderBottom: '1px solid #eee' }}>
                                            <td style={{ padding: '12px', fontWeight: 'bold' }}>{app.fulfilled_course}</td>
                                            <td style={{ padding: '12px' }}>{app.pte_course_name}</td>
                                            <td style={{ padding: '12px', textAlign: 'center' }}>
                                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px' }}>
                                                    <span style={{ fontWeight: 'bold', padding: '5px 10px', borderRadius: '15px', color: 'white', fontSize: '11px', backgroundColor: app.status === 'approved' ? '#28a745' : app.status === 'rejected' ? '#dc3545' : app.status === 'needs_info' ? '#fd7e14' : '#007bff' }}>
                                                        {app.status === 'needs_info' ? 'NEEDS INFO' : app.status.toUpperCase()}
                                                    </span>
                                                    {(app.status === 'needs_info' || app.status === 'rejected') && app.reviewer_note && (
                                                        <span style={{ fontSize: '11px', color: '#dc3545', fontStyle: 'italic', maxWidth: '200px', textAlign: 'center' }}>"{app.reviewer_note}"</span>
                                                    )}
                                                </div>
                                            </td>
                                            <td style={{ padding: '12px', textAlign: 'center' }}>
                                                {app.status === 'needs_info' ? (
                                                    <button onClick={() => setResubmitModal({ isOpen: true, app: app })} style={{ padding: '6px 12px', backgroundColor: '#fd7e14', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 2px 4px rgba(0,0,0,0.2)' }}>✏️ Add Missing Info</button>
                                                ) : (
                                                    <span style={{ color: '#6c757d', fontSize: '13px', fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
                                                        🔒 {app.status === 'pending' ? 'Under Review' : 'Finalized'}
                                                    </span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {/* STUDENT RESUBMIT MODAL */}
                    {resubmitModal.isOpen && (
                        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
                            <div style={{ backgroundColor: '#fff', padding: '25px', borderRadius: '10px', width: '500px', boxShadow: '0 5px 15px rgba(0,0,0,0.3)' }}>
                                <h3 style={{ marginTop: 0, color: '#fd7e14' }}>⚠️ Action Required: Additional Info Needed</h3>
                                
                                <div style={{ backgroundColor: '#fff3cd', padding: '15px', borderRadius: '5px', marginBottom: '20px', borderLeft: '5px solid #fd7e14' }}>
                                    <strong style={{ color: '#856404' }}>Message from Reviewer:</strong>
                                    <p style={{ margin: '5px 0 0 0', color: '#555', fontStyle: 'italic' }}>"{resubmitModal.app.reviewer_note}"</p>
                                </div>

                                <label style={{ fontWeight: 'bold', fontSize: '14px', display: 'block', marginBottom: '8px' }}>Attach Missing Proof:</label>
                                <div style={{ border: '2px dashed #ccc', padding: '15px', borderRadius: '5px', textAlign: 'center' }}>
                                    <input type="file" onChange={handleResubmitFileUpload} />
                                </div>

                                {resubmitFiles.length > 0 && (
                                    <div style={{ marginTop: '10px', display: 'flex', gap: '5px' }}>
                                        {resubmitFiles.map((file, idx) => (
                                            <img key={idx} src={`http://localhost:9000/transcripts/${file}`} alt="New Proof" style={{ height: '50px', border: '1px solid #28a745', borderRadius: '3px' }} />
                                        ))}
                                    </div>
                                )}

                                {uploadStatus && <p style={{ color: '#004085', fontWeight: 'bold', marginTop: '10px', textAlign: 'center' }}>{uploadStatus}</p>}

                                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                                    <button onClick={() => { setResubmitModal({ isOpen: false, app: null }); setResubmitFiles([]); setUploadStatus(''); }} style={{ padding: '10px 15px', cursor: 'pointer', border: '1px solid #ccc', borderRadius: '4px', backgroundColor: '#f8f9fa', fontWeight: 'bold' }}>Cancel</button>
                                    <button onClick={submitResubmission} style={{ padding: '10px 15px', cursor: 'pointer', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>📤 Resubmit Application</button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* NEW APPLICATION TAB */}
                    {studentTab === 'submit' && (
                        <div style={{ backgroundColor: '#e2e3f0', padding: '20px', borderRadius: '10px', border: '1px solid #b8daff', maxWidth: '800px' }}>
                            <h2 style={{ marginTop: 0, color: '#004085' }}>🎓 New Application</h2>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', backgroundColor: '#fff', padding: '15px', borderRadius: '5px', marginBottom: '20px' }}>
                                <div><label style={{ fontSize: '12px', fontWeight: 'bold' }}>Name {matches.name && <span style={{ color: 'green' }}>✅</span>}</label><input type="text" value={fulfilledCourse} onChange={(e) => setFulfilledCourse(e.target.value)} style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }} /></div>
                                <div><label style={{ fontSize: '12px', fontWeight: 'bold' }}>Code</label><input type="text" value={fulfilledCourseCode} onChange={(e) => setFulfilledCourseCode(e.target.value)} style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }} /></div>
                                <div><label style={{ fontSize: '12px', fontWeight: 'bold' }}>Credits {matches.credits && <span style={{ color: 'green' }}>✅</span>}</label><input type="number" step="0.5" value={fulfilledCredits} onChange={(e) => setFulfilledCredits(e.target.value)} style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }} /></div>
                                <div><label style={{ fontSize: '12px', fontWeight: 'bold' }}>Grade</label><input type="text" value={fulfilledGrade} onChange={(e) => setFulfilledGrade(e.target.value)} style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }} /></div>
                            </div>
                            <div style={{ marginBottom: '20px' }}>
                                <label style={{ fontWeight: 'bold', color: '#004085' }}>Target PTE Courses (One-to-Many Support):</label>
                                <select value="" onChange={(e) => {
                                        const course = courses.find(c => c.id === parseInt(e.target.value));
                                        if (course && !selectedCourses.find(sc => sc.id === course.id)) setSelectedCourses([...selectedCourses, course]);
                                    }} style={{ width: '100%', padding: '10px', marginTop: '5px', border: '1px solid #ccc', borderRadius: '4px' }}>
                                    <option value="">-- Select & Add PTE Courses --</option>
                                    {courses.map(c => <option key={c.id} value={c.id}>{c.course_code} - {c.course_name} ({c.credits} Credits)</option>)}
                                </select>
                                <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                    {selectedCourses.map(sc => (
                                        <span key={sc.id} style={{ backgroundColor: '#004085', color: 'white', padding: '5px 12px', borderRadius: '20px', fontSize: '12px', display: 'flex', alignItems: 'center' }}>
                                            {sc.course_name}
                                            <button onClick={() => setSelectedCourses(selectedCourses.filter(c => c.id !== sc.id))} style={{ background: 'none', border: 'none', color: 'white', marginLeft: '8px', cursor: 'pointer', fontWeight: 'bold' }}>×</button>
                                        </span>
                                    ))}
                                </div>
                            </div>
                            {evidenceRequiredMsg && (
                                <div style={{ backgroundColor: '#d1ecf1', color: '#0c5460', padding: '15px', borderRadius: '5px', marginBottom: '20px' }}><strong>ℹ️ Notice:</strong> {evidenceRequiredMsg}</div>
                            )}
                            {uploadedFiles.length > 0 && (
                                <div style={{ marginBottom: '15px' }}>
                                    <label style={{ fontWeight: 'bold', color: '#28a745' }}>✅ Attached Evidence ({uploadedFiles.length}):</label>
                                    <div style={{ display: 'flex', gap: '10px', marginTop: '5px', flexWrap: 'wrap' }}>
                                        {uploadedFiles.map((file, index) => (
                                            <div key={index} style={{ position: 'relative', border: '2px solid #28a745', borderRadius: '5px', padding: '3px', backgroundColor: '#fff' }}><img src={`http://localhost:9000/transcripts/${file}`} alt="Proof" style={{ height: '60px', objectFit: 'cover', borderRadius: '3px' }} /></div>
                                        ))}
                                    </div>
                                </div>
                            )}
                            <button onClick={() => setShowUploader(!showUploader)} style={{ marginBottom: '10px', cursor: 'pointer', padding: '10px', backgroundColor: uploadedFiles.length > 0 ? '#6c757d' : '#007bff', color: 'white', border: 'none', borderRadius: '5px', fontWeight: 'bold' }}>
                                {showUploader ? 'Hide Uploader' : (uploadedFiles.length > 0 ? '➕ Upload More Proof' : '📸 Upload & Mark Evidence')}
                            </button>
                            {showUploader && (
                                <div style={{ backgroundColor: '#fff', padding: '15px', border: '2px dashed #007bff', borderRadius: '5px', marginBottom: '20px' }}>
                                    <input type="file" onChange={(e) => setPreviewUrl(URL.createObjectURL(e.target.files[0]))} />
                                    {previewUrl && (
                                        <div style={{ marginTop: '10px' }}>
                                            <button onClick={() => setActiveTool('pen')} style={{ padding: '5px 10px', marginRight: '5px', cursor: 'pointer' }}>🔴 Pen</button>
                                            <button onClick={() => setActiveTool('eraser')} style={{ padding: '5px 10px', cursor: 'pointer' }}>🧹 Eraser</button>
                                            <div style={{ position: 'relative', display: 'inline-block', marginTop: '10px', border: '1px solid #000' }}>
                                                <img ref={imgRef} src={previewUrl} onLoad={handleImageLoad} style={{ maxWidth: '100%' }} alt="Syllabus" />
                                                <canvas ref={canvasRef} onMouseDown={({ nativeEvent: { offsetX, offsetY } }) => { ctx.beginPath(); ctx.moveTo(offsetX, offsetY); ctx.lineWidth = activeTool === 'pen' ? 3 : 30; ctx.strokeStyle = 'red'; ctx.globalCompositeOperation = activeTool === 'pen' ? 'source-over' : 'destination-out'; setIsDrawing(true); }} onMouseMove={({ nativeEvent: { offsetX, offsetY } }) => { if (isDrawing) { ctx.lineTo(offsetX, offsetY); ctx.stroke(); } }} onMouseUp={() => setIsDrawing(false)} style={{ position: 'absolute', top: 0, left: 0 }} />
                                            </div><br/>
                                            <button onClick={handleUploadHighlighted} style={{ marginTop: '10px', cursor: 'pointer', padding: '8px 15px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px' }}>Save Evidence Page</button>
                                            <p style={{ fontWeight: 'bold' }}>{uploadStatus}</p>
                                        </div>
                                    )}
                                </div>
                            )}
                            <button onClick={handleSubmitApplication} style={{ width: '100%', padding: '15px', backgroundColor: '#004085', color: 'white', fontWeight: 'bold', cursor: 'pointer', border: 'none', borderRadius: '5px', marginTop: '10px' }}>🚀 Submit Transfer Request</button>
                            {submitStatus && <p style={{ color: 'red', textAlign: 'center', fontWeight: 'bold' }}>{submitStatus}</p>}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default Dashboard;