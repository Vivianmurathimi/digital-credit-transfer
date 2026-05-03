import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';

const ReviewerDashboard = () => {
    const { t } = useTranslation();
    const [applications, setApplications] = useState([]);
    const [reviewerTab, setReviewerTab] = useState('pending');
    const [feedbackModal, setFeedbackModal] = useState({ isOpen: false, appId: null, type: '' });
    const [reviewerNote, setReviewerNote] = useState('');
    const [feedbackUploadStatus, setFeedbackUploadStatus] = useState('');

    const fetchApplications = useCallback(async () => {
        try {
            const res = await axios.get('/api/applications');
            if (res.data.success) setApplications(res.data.applications);
        } catch (err) { 
            console.error('Error fetching apps', err); 
        }
    }, []);

    useEffect(() => {
        fetchApplications();
    }, [fetchApplications]);

    // --- Helper to safely parse the Phase 1 JSON array ---
    const parseCourses = (jsonStringOrArray) => {
        if (!jsonStringOrArray) return [];
        if (Array.isArray(jsonStringOrArray)) return jsonStringOrArray;
        try { return JSON.parse(jsonStringOrArray); } catch (e) { return []; }
    };

    const getUploadLink = (fileName) => {
        return `http://localhost:5000/api/uploads/${fileName}`;
    };

    const handleDownload = async (fileName) => {
        try {
            // Make sure this URL perfectly matches your <img> src URL!
            const response = await fetch(getUploadLink(fileName));
            
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url; 
            link.download = fileName; // Forces the download
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (err) {
            alert(t('reviewer_download_failed'));
        }
    };

    const submitReviewerDecision = async () => {
        if (feedbackModal.type !== 'approved' && !reviewerNote.trim()) {
            return alert(t('reviewer_note_required'));
        }
        
        try {
            setFeedbackUploadStatus(t('reviewer_decision_submitting'));
            const noteToSend = feedbackModal.type === 'approved' ? t('reviewer_confirm_approve_text') : reviewerNote;
            
            const res = await axios.put(`/api/applications/${feedbackModal.appId}/status`, { status: feedbackModal.type, note: noteToSend });
            if (res.data.success) {
                alert(t('reviewer_application_marked', { status: t(`status_${feedbackModal.type}`) }));
                setFeedbackModal({ isOpen: false, appId: null, type: '' });
                setReviewerNote('');
                setFeedbackUploadStatus('');
                fetchApplications(); 
            }
        } catch (err) {
            setFeedbackUploadStatus(t('reviewer_decision_failed'));
        }
    };

    const pendingApps = applications.filter(a => a.status === 'pending');
    const needsInfoApps = applications.filter(a => a.status === 'needs_info');
    const completedApps = applications.filter(a => a.status === 'approved' || a.status === 'rejected');
    const activeReviewerApps = reviewerTab === 'pending' ? pendingApps : reviewerTab === 'needs_info' ? needsInfoApps : completedApps;

    const getModalTitle = () => {
        if (feedbackModal.type === 'approved') return t('reviewer_confirm_title_approved');
        if (feedbackModal.type === 'needs_info') return t('reviewer_confirm_title_needs_info');
        return t('reviewer_confirm_title_rejected');
    };

    return (
        <div style={{ backgroundColor: '#e2f0d9', padding: '20px', borderRadius: '10px' }}>
            <h2 style={{ marginTop: 0, color: '#155724' }}>{t('reviewer_title')}</h2>
            
            <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '2px solid #c3e6cb', paddingBottom: '10px' }}>
                <button onClick={() => setReviewerTab('pending')} style={{ padding: '10px 20px', cursor: 'pointer', border: 'none', borderRadius: '20px', fontWeight: 'bold', backgroundColor: reviewerTab === 'pending' ? '#fff' : 'transparent', color: '#155724' }}>
                    {t('reviewer_pending_tab')} <span style={{ backgroundColor: '#ffc107', color: '#000', padding: '2px 8px', borderRadius: '10px', marginLeft: '5px' }}>{pendingApps.length}</span>
                </button>
                <button onClick={() => setReviewerTab('needs_info')} style={{ padding: '10px 20px', cursor: 'pointer', border: 'none', borderRadius: '20px', fontWeight: 'bold', backgroundColor: reviewerTab === 'needs_info' ? '#fff' : 'transparent', color: '#155724' }}>
                    {t('reviewer_needs_info_tab')} <span style={{ backgroundColor: '#fd7e14', color: '#fff', padding: '2px 8px', borderRadius: '10px', marginLeft: '5px' }}>{needsInfoApps.length}</span>
                </button>
                <button onClick={() => setReviewerTab('completed')} style={{ padding: '10px 20px', cursor: 'pointer', border: 'none', borderRadius: '20px', fontWeight: 'bold', backgroundColor: reviewerTab === 'completed' ? '#fff' : 'transparent', color: '#155724' }}>
                    {t('reviewer_completed_tab')} <span style={{ backgroundColor: '#28a745', color: '#fff', padding: '2px 8px', borderRadius: '10px', marginLeft: '5px' }}>{completedApps.length}</span>
                </button>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', backgroundColor: '#fff' }}>
                <thead>
                    <tr style={{ backgroundColor: '#28a745', color: 'white' }}>
                        <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>{t('reviewer_student')}</th>
                        <th style={{ padding: '10px', textAlign: 'left', width: '25%' }}>{t('reviewer_fulfilled_course')}</th>
                        <th style={{ padding: '10px', textAlign: 'left', width: '25%' }}>{t('reviewer_target_courses')}</th>
                        <th style={{ padding: '10px', textAlign: 'center', width: '20%' }}>{t('reviewer_evidence')}</th>
                        <th style={{ padding: '10px', textAlign: 'center', width: '10%' }}>{t('reviewer_actions')}</th>
                    </tr>
                </thead>
                <tbody>
                    {activeReviewerApps.length === 0 ? (
                        <tr><td colSpan="5" style={{ textAlign: 'center', padding: '20px' }}>{t('reviewer_no_apps')}</td></tr>
                    ) : activeReviewerApps.map(app => {
                        // --- Extract the JSON List per application ---
                        const coursesList = parseCourses(app.fulfilled_courses_json);
                        
                        return (
                        <tr key={app.id} style={{ borderBottom: '1px solid #eee' }}>
                            
                            {/* --- PHASE 2: Student Name + Cover Letter Note --- */}
                            <td style={{ padding: '10px', verticalAlign: 'top' }}>
                                <div style={{ fontWeight: 'bold', fontSize: '15px' }}>{app.student_name}</div>
                                {app.student_note && (
                                    <div style={{ marginTop: '10px', backgroundColor: '#fff3cd', padding: '10px', borderRadius: '5px', fontSize: '12px', borderLeft: '4px solid #ffc107', color: '#856404' }}>
                                        <strong style={{ display: 'block', marginBottom: '4px' }}>📝 Student's Note:</strong> 
                                        {app.student_note}
                                    </div>
                                )}
                                {app.student_resubmit_note && (
                                    <div style={{ marginTop: '10px', backgroundColor: '#d1ecf1', padding: '10px', borderRadius: '5px', fontSize: '12px', borderLeft: '4px solid #17a2b8', color: '#0c5460' }}>
                                        <strong style={{ display: 'block', marginBottom: '4px' }}>🔄 Resubmit Note:</strong>
                                        {app.student_resubmit_note}
                                    </div>
                                )}
                                {app.reviewer_note && (
                                    <div style={{ marginTop: '10px', backgroundColor: '#f8d7da', padding: '10px', borderRadius: '5px', fontSize: '12px', borderLeft: '4px solid #dc3545', color: '#721c24' }}>
                                        <strong style={{ display: 'block', marginBottom: '4px' }}>🧾 Reviewer Note:</strong>
                                        {app.reviewer_note}
                                    </div>
                                )}
                            </td>

                            {/* --- PHASE 1: Stacked List of Fulfilled Courses --- */}
                            <td style={{ padding: '10px', color: '#004085', verticalAlign: 'top' }}>
                                <ul style={{ listStyleType: 'none', padding: 0, margin: 0 }}>
                                    {coursesList.map((course, idx) => (
                                        <li key={idx} style={{ marginBottom: '8px' }}>
                                            📘 <strong>{course.course_name}</strong><br/>
                                            <span style={{ fontSize: '11px', color: '#555' }}>
                                                Code: {course.course_code} | {course.credits} Cr | Grade: {course.grade}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </td>

                            <td style={{ padding: '10px', color: '#28a745', fontWeight: 'bold', verticalAlign: 'top' }}>
                                <ul style={{ margin: 0, paddingLeft: '15px', listStyleType: 'disc' }}>
                                    {app.pte_course_names ? app.pte_course_names.split(' + ').map((courseName, idx) => (
                                        <li key={idx} style={{ marginBottom: '5px' }}>{courseName}</li>
                                    )) : <li>{t('reviewer_no_courses_listed')}</li>}
                                </ul>
                            </td>

                            {/* --- PHASE 1: Stacked List of Labeled Evidence --- */}
                            <td style={{ padding: '10px', textAlign: 'center', verticalAlign: 'top' }}>
                                <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
                                    {coursesList.map((course, idx) => course.file && (
                                        <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '5px', alignItems: 'center', border: '1px solid #ddd', padding: '5px', borderRadius: '6px', backgroundColor: '#f8f9fa' }}>
                                            <div style={{ fontSize: '10px', fontWeight: 'bold', maxWidth: '70px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={course.course_name}>
                                                📄 {course.course_name}
                                            </div>
                                            <img 
                                                src={getUploadLink(course.file)} 
                                                alt={t('reviewer_evidence')} 
                                                onClick={() => window.open(getUploadLink(course.file))} 
                                                style={{ width: '45px', height: '45px', objectFit: 'cover', border: '1px solid #ccc', cursor: 'pointer' }} 
                                            />
                                            <button onClick={() => handleDownload(course.file)} title={t('reviewer_download_title')} style={{ cursor: 'pointer', fontSize: '11px', padding: '3px 0', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '3px', width: '100%', fontWeight: 'bold' }}>📥</button>
                                        </div>
                                    ))}
                                </div>
                                {app.supplemental_files && (
                                    <div style={{ marginTop: '10px', textAlign: 'left', backgroundColor: '#e2f0ff', padding: '10px', borderRadius: '5px', border: '1px solid #b8daff', color: '#004085' }}>
                                        <strong style={{ display: 'block', marginBottom: '6px' }}>📎 Supplemental Files:</strong>
                                        <ul style={{ margin: 0, paddingLeft: '20px' }}>
                                            {app.supplemental_files.split(',').map((file, idx) => (
                                                <li key={idx} style={{ marginBottom: '4px' }}>
                                                    <a href={getUploadLink(file)} target="_blank" rel="noopener noreferrer" style={{ color: '#007bff', textDecoration: 'none' }}>
                                                        {file}
                                                    </a>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </td>

                            <td style={{ padding: '10px', textAlign: 'center', verticalAlign: 'top' }}>
                                {reviewerTab !== 'completed' ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                                        <button onClick={() => setFeedbackModal({ isOpen: true, appId: app.id, type: 'approved' })} style={{ backgroundColor: '#28a745', color: 'white', cursor: 'pointer', padding: '6px', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>{t('reviewer_approve')}</button>
                                        <button onClick={() => setFeedbackModal({ isOpen: true, appId: app.id, type: 'needs_info' })} style={{ backgroundColor: '#fd7e14', color: 'white', cursor: 'pointer', padding: '6px', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>{t('reviewer_request_info')}</button>
                                        <button onClick={() => setFeedbackModal({ isOpen: true, appId: app.id, type: 'rejected' })} style={{ backgroundColor: '#dc3545', color: 'white', cursor: 'pointer', padding: '6px', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>{t('reviewer_reject')}</button>
                                    </div>
                                ) : (
                                    <strong style={{ color: app.status === 'approved' ? 'green' : 'red' }}>{t(`status_${app.status}`)}</strong>
                                )}
                            </td>
                        </tr>
                    )})}
                </tbody>
            </table>

            {feedbackModal.isOpen && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
                    <div style={{ backgroundColor: '#fff', padding: '25px', borderRadius: '10px', width: '400px', boxShadow: '0 5px 15px rgba(0,0,0,0.3)' }}>
                        <h3 style={{ marginTop: 0, color: feedbackModal.type === 'needs_info' ? '#fd7e14' : feedbackModal.type === 'approved' ? '#28a745' : '#dc3545' }}>
                            {getModalTitle()}
                        </h3>
                        
                        {feedbackModal.type === 'approved' ? (
                            <p style={{ color: '#28a745', fontWeight: 'bold', fontSize: '15px' }}>{t('reviewer_confirm_approve_text')}</p>
                        ) : (
                            <>
                                <label style={{ fontWeight: 'bold', fontSize: '14px' }}>{t('reviewer_rationale_note_label')}</label>
                                <textarea value={reviewerNote} onChange={(e) => setReviewerNote(e.target.value)} placeholder={t('reviewer_note_placeholder')} style={{ width: '100%', height: '100px', marginTop: '8px', padding: '10px', boxSizing: 'border-box', border: '1px solid #ccc', borderRadius: '4px' }} />
                            </>
                        )}

                        {feedbackUploadStatus && <p style={{ color: '#004085', fontWeight: 'bold', marginTop: '10px' }}>{feedbackUploadStatus}</p>}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                            <button onClick={() => { setFeedbackModal({ isOpen: false }); setReviewerNote(''); }} style={{ padding: '8px 15px', cursor: 'pointer', border: '1px solid #ccc', borderRadius: '4px' }}>{t('reviewer_cancel')}</button>
                            <button onClick={submitReviewerDecision} style={{ padding: '8px 15px', cursor: 'pointer', backgroundColor: feedbackModal.type === 'approved' ? '#28a745' : '#004085', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>{t('reviewer_confirm_decision')}</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ReviewerDashboard;