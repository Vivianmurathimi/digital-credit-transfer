import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense, lazy } from 'react';
import http, { API_PREFIX } from '../http';
import { getToken } from '../session';
import { onSessionEnding } from '../sessionKeeper';
import { useTranslation } from 'react-i18next';
import { getErrorCode, getErrorMessage, getFieldErrors } from '../errorMessage';
import SecureImage from './SecureImage';
import SubmitSummary from './SubmitSummary';
import { getUploadEndpoint, openSecureFile } from '../secureFiles';
import { MAX_MB, ACCEPT, checkFile, tooLargeToUpload } from '../fileRules';
import { CREDIT_SYSTEMS, LIMITS, newInstitution, newCourseRow, allEcts, rowHasContent, rowsUsingInstitution, removeInstitution, countryOptions, buildSubmission, validateSubmission, formKeyForPath, syllabusReasons, syllabusReasonsWhileEditing, missingSyllabi, blockedCourseCodes, normalizeCourseCode,
    NOTE_MAX, noteLength, checkNote, DRAFT_VERSION, DRAFT_SAVE_DELAY_MS, draftFromForm, isEmptyDraft, formFromDraft, DRAFT_MAX_KB } from '../applicationForm';


// What the form's draft remembers when the server holds no draft (see the draft section below)
const NOTHING_SAVED = '';

// The highlighter (with the PDF libraries) is only downloaded when a student opens a syllabus
const EvidenceHighlighter = lazy(() => import('./EvidenceHighlighter'));

// Live character counter for a note. Screen readers only hear it at a few points near the limit
// (200, 100 and 50 left, at the limit, over it), not on every keystroke.
const visuallyHidden = { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };
const NoteCounter = ({ id, text, t }) => {
    const used = noteLength(text);
    const left = NOTE_MAX - used;
    const stage = left < 0 ? 'over' : left === 0 ? 0 : left <= 50 ? 50 : left <= 100 ? 100 : left <= 200 ? 200 : null;
    let announcement = '';
    if (stage === 'over') announcement = t('student_note_over', { over: -left });
    else if (stage !== null) announcement = t('student_note_left', { left: stage === 0 ? 0 : stage });
    return (
        <div id={id} style={{ fontSize: '12px', textAlign: 'right', marginTop: '4px', color: left < 0 ? 'var(--error-text)' : 'var(--text-muted)', fontWeight: left < 0 ? 'bold' : 'normal' }}>
            {t('student_note_counter', { used, max: NOTE_MAX })}
            <span aria-live="polite" style={visuallyHidden}>{announcement}</span>
        </div>
    );
};

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
    // Inline errors, keyed by the form's own field keys: 'inst:<key>:country', 'row:<id>:credits',
    // 'target_course_ids', 'institutions', 'fulfilled_courses' (see formKeyForPath)
    const [fieldErrors, setFieldErrors] = useState({});
    // The "please correct the marked fields" summary under Submit, shown after a failed submit
    const [showErrorSummary, setShowErrorSummary] = useState(false);
    const [selectedCourses, setSelectedCourses] = useState([]); 
    
    // --- PHASE 2: Student Cover Letter ---
    const [studentNote, setStudentNote] = useState('');
    
    // --- INLINE UPLOAD STATE ---
    const [activeUploadId, setActiveUploadId] = useState(null); 
    // The syllabus file open in the highlighter (PDF or image), per uploader
    const [highlightFile, setHighlightFile] = useState(null);
    const [uploadStatus, setUploadStatus] = useState('');
    const [submitStatus, setSubmitStatus] = useState('');
    
    // --- PHASE 3: Dashboard & Resubmit State ---
    const [myApplications, setMyApplications] = useState([]); 
    const [resubmitModal, setResubmitModal] = useState({ isOpen: false, app: null });
    const [resubmitFiles, setResubmitFiles] = useState([]);
    const [resubmitNote, setResubmitNote] = useState(''); 
    const [resubmitNoteError, setResubmitNoteError] = useState('');
    // Confirmation summary before the final submit, and the success message afterwards
    const [summaryOpen, setSummaryOpen] = useState(false);
    const [summaryBusy, setSummaryBusy] = useState(false);
    const [submitSuccess, setSubmitSuccess] = useState(false);
    const submitButtonRef = useRef(null);
    const successRef = useRef(null);
    const [resubmitHighlightFile, setResubmitHighlightFile] = useState(null);
    const [isNoteExpanded, setIsNoteExpanded] = useState(false);
    
    // Original file names for display: stored name -> name the student chose
    const [fileNames, setFileNames] = useState({});
    // Syllabus uploads (only when the syllabus rule applies): the course row being uploaded for,
    // its chosen file, and a status per row ({ uploading: true } or { message: '…' })
    const [syllabusRowId, setSyllabusRowId] = useState(null);
    const [syllabusFile, setSyllabusFile] = useState(null);
    const [syllabusStatus, setSyllabusStatus] = useState({});
    const syllabusInput = useRef(null);
    const syllabusPickRow = useRef(null);
    const [isSubmissionsOpen, setIsSubmissionsOpen] = useState(true);


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

    // --- Inline errors ---
    const setFieldError = (key, message) => setFieldErrors((prev) => {
        if (!message && !(key in prev)) return prev;
        const next = { ...prev };
        if (message) next[key] = message; else delete next[key];
        return next;
    });
    const dropFieldErrors = (prefix) => setFieldErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith(prefix))));
    const isCountryCode = (code) => countryCodes.includes(code);
    const translateError = (e) => t(`errors.${e.code}`, e.params || {});

    // DOM id of each field, for labels, focusing the first error and linking the error text
    const ROW_DOM = { institution: 'row-inst', course_name: 'row-name', course_code: 'row-code', credits: 'row-credits', credit_system: 'row-system', credit_system_other: 'row-system-other', grade: 'row-grade', file: 'row-evidence-btn', syllabus_file: 'row-syllabus-btn' };
    const INST_DOM = { name: 'inst-name', country: 'inst-country', grading_file: 'inst-grading-btn' };
    const domIdFor = (key) => {
        const [kind, id, field] = key.split(':');
        if (kind === 'row') return `${ROW_DOM[field]}-${id}`;
        if (kind === 'inst') return `${INST_DOM[field]}-${id}`;
        return { target_course_ids: 'target-course-select', student_note: 'student-note', institutions: 'institutions-title', fulfilled_courses: 'fulfilled-courses-start' }[key];
    };
    const fieldProps = (key) => {
        const id = domIdFor(key);
        return fieldErrors[key]
            ? { id, 'aria-invalid': true, 'aria-describedby': `${id}-error` }
            : { id };
    };
    const inputStyle = (key) => (fieldErrors[key] ? { ...fieldInputStyle, border: '2px solid var(--danger-border)' } : fieldInputStyle);
    const renderFieldError = (key) => (fieldErrors[key]
        ? <p id={`${domIdFor(key)}-error`} style={{ color: 'var(--error-text)', fontSize: '12px', fontWeight: 'bold', margin: '4px 0 0 0' }}>{fieldErrors[key]}</p>
        : null);

    // The body that would be sent now, and the maps from its positions back to the form's keys
    const currentSubmission = () => {
        const { institutionKeyAt, rowIdAt, ...form } = buildSubmission(institutions, fulfilledCourses);
        return { body: { ...form, target_course_ids: selectedCourses.map((c) => c.id), student_note: studentNote }, map: { institutionKeyAt, rowIdAt } };
    };

    // On leaving a field: check just that field, and only if something was entered
    // (empty required fields are reported on Submit). "No course uses this institution"
    // is also left for Submit, since courses are usually linked after the name is typed.
    const checkField = (key, value) => {
        if (String(value ?? '').trim() === '') return;
        const { body, map } = currentSubmission();
        const problem = validateSubmission(body, isCountryCode)
            .find((e) => e.code !== 'INSTITUTION_UNUSED' && formKeyForPath(e.field, map) === key);
        setFieldError(key, problem ? translateError(problem) : '');
    };

    // Shows errors under their fields ([path, message] pairs with server paths), focuses the first one.
    // Paths the form doesn't know go to the message under Submit.
    const showErrors = (pairs, map) => {
        const next = {};
        const unplaced = [];
        pairs.forEach(([path, message]) => {
            const key = formKeyForPath(path, map);
            if (!key) unplaced.push(message);
            else if (!(key in next)) next[key] = message;
        });
        setFieldErrors(next);
        setShowErrorSummary(Object.keys(next).length > 0);
        setSubmitStatus(unplaced.join(' '));
        const first = Object.keys(next)[0];
        if (first) {
            setTimeout(() => {
                const el = document.getElementById(domIdFor(first));
                if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
            }, 0);
        }
    };
    const errorCount = Object.keys(fieldErrors).length;

    // The name the student chose (stored names start with a timestamp)
    const displayName = (stored) => fileNames[stored] || String(stored || '').replace(/^\d+-/, '');
    const rememberName = (data) => { if (data.originalName) setFileNames((prev) => ({ ...prev, [data.fileName]: data.originalName })); };

    // Syllabus rule and credit check, worked out from the current form (same rule as the server).
    // null while it can't be judged yet (no PTE course, or a row without credits or credit system).
    const targetCourse = selectedCourses[0] || null;
    const syllabusNeededFor = syllabusReasonsWhileEditing(fulfilledCourses, targetCourse);
    const creditsMatch = syllabusNeededFor !== null && allEcts(fulfilledCourses) && !syllabusNeededFor.includes('CREDIT_GAP');
    const syllabusNeeded = Boolean(syllabusNeededFor && syllabusNeededFor.length > 0);
    const allSyllabiAttached = fulfilledCourses.every((c) => c.syllabus_file);

    // --- Draft (Group 7): the unsent form is saved on the server while the student types ---
    // Restored when the form is opened again (also in another browser). One draft per student;
    // with two tabs open, the last save wins. Off while the superadmin views a student's dashboard.
    const draftsEnabled = !isImpersonating;
    // 'loading' -> 'ready' (autosave on) | 'failed' (autosave paused, so the stored draft is never overwritten)
    const [draftPhase, setDraftPhase] = useState(draftsEnabled ? 'loading' : 'off');
    const draftReady = useRef(false);
    // { kind: 'saving' } | { kind: 'saved', at } | { kind: 'error', code } | null
    const [draftStatus, setDraftStatus] = useState(null);
    const [draftNotices, setDraftNotices] = useState([]);
    // JSON of what the server holds now (NOTHING_SAVED = no draft there)
    const lastSavedDraft = useRef(NOTHING_SAVED);
    const draftTimer = useRef(null);
    const draftQueue = useRef(Promise.resolve()); // saves run one after another, never out of order
    // The token at the last change: when the page is left after Log Out, the stored one is already gone
    const draftToken = useRef(null);

    const currentDraft = draftFromForm({ institutions, rows: fulfilledCourses, targetCourseId: targetCourse ? targetCourse.id : null, note: studentNote });
    const currentDraftJson = JSON.stringify(currentDraft);
    const currentDraftRef = useRef(currentDraft);
    currentDraftRef.current = currentDraft;

    // Saves the form now if it changed since the last save (an emptied form deletes the draft)
    const saveDraft = useCallback(() => {
        clearTimeout(draftTimer.current);
        draftQueue.current = draftQueue.current.then(async () => {
            if (!draftReady.current) return;
            const draft = currentDraftRef.current;
            const json = JSON.stringify(draft);
            if (json === lastSavedDraft.current) return;
            const empty = isEmptyDraft(draft);
            if (empty && lastSavedDraft.current === NOTHING_SAVED) return;
            setDraftStatus({ kind: 'saving' });
            try {
                if (empty) {
                    await http.delete('drafts/mine');
                    lastSavedDraft.current = NOTHING_SAVED;
                    setDraftStatus(null);
                } else {
                    const data = await http.put('drafts/mine', { json: { version: DRAFT_VERSION, data: draft } }).json();
                    lastSavedDraft.current = json;
                    setDraftStatus({ kind: 'saved', at: data.updated_at });
                }
            } catch (err) {
                // Tried again at the next change, on leaving the page and before an idle logout
                setDraftStatus({ kind: 'error', code: getErrorCode(err) });
            }
        });
        return draftQueue.current;
    }, []);

    // Leaving the page (closing the tab, reloading, Log Out): a normal request could be cut off,
    // so the last changes go with keepalive, which the browser finishes after the page is gone
    const saveDraftOnLeave = useCallback(() => {
        clearTimeout(draftTimer.current);
        if (!draftReady.current) return;
        const draft = currentDraftRef.current;
        const json = JSON.stringify(draft);
        if (json === lastSavedDraft.current) return;
        const empty = isEmptyDraft(draft);
        if (empty && lastSavedDraft.current === NOTHING_SAVED) return;
        const token = getToken() || draftToken.current;
        if (!token) return;
        const body = empty ? undefined : JSON.stringify({ version: DRAFT_VERSION, data: draft });
        try {
            fetch(`${API_PREFIX}/drafts/mine`, {
                method: empty ? 'DELETE' : 'PUT',
                headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                body,
                // Browsers allow keepalive only up to 64 KB; a larger draft (rare) is sent normally
                keepalive: !body || new Blob([body]).size < 60 * 1024,
            }).catch(() => {});
            lastSavedDraft.current = json;
        } catch { /* nothing more can be done while the page closes */ }
    }, []);

    // Restore the draft once the course list is there (the target course is kept by its id)
    const draftLoadStarted = useRef(false);
    useEffect(() => {
        if (!draftsEnabled || !coursesLoaded || draftLoadStarted.current) return;
        draftLoadStarted.current = true;
        (async () => {
            try {
                const { draft } = await http.get('drafts/mine').json();
                const notices = [];
                if (draft && draft.version !== DRAFT_VERSION) {
                    // Made with an older form: not restored, so nothing is filled in wrongly
                    await http.delete('drafts/mine');
                    notices.push({ key: 'student_draft_outdated' });
                } else if (draft) {
                    const form = formFromDraft(draft.data);
                    const target = courses.find((c) => c.id === form.targetCourseId) || null;
                    setInstitutions(form.institutions);
                    setFulfilledCourses(form.rows);
                    setSelectedCourses(target ? [target] : []);
                    setStudentNote(form.note);
                    setFileNames((prev) => ({ ...prev, ...(draft.file_names || {}) }));
                    notices.push({ key: 'student_draft_restored', params: { time: draft.updated_at } });
                    if (draft.dropped_files > 0) notices.push({ key: 'student_draft_files_dropped', params: { count: draft.dropped_files } });
                    const courseDropped = form.targetCourseId !== null && !target;
                    if (courseDropped) notices.push({ key: 'student_draft_course_dropped' });
                    // With something removed, the cleaned form is saved at once; otherwise it matches the server
                    const restored = JSON.stringify(draftFromForm({ ...form, targetCourseId: target ? target.id : null }));
                    lastSavedDraft.current = draft.dropped_files > 0 || courseDropped ? null : restored;
                }
                setDraftNotices(notices);
                draftReady.current = true;
                setDraftPhase('ready');
            } catch (err) {
                setDraftPhase('failed');
            }
        })();
    }, [draftsEnabled, coursesLoaded, courses]);

    // Autosave: DRAFT_SAVE_DELAY_MS after the last change
    useEffect(() => {
        if (draftPhase !== 'ready') return undefined;
        draftToken.current = getToken() || draftToken.current;
        if (currentDraftJson === lastSavedDraft.current) return undefined;
        clearTimeout(draftTimer.current);
        draftTimer.current = setTimeout(saveDraft, DRAFT_SAVE_DELAY_MS);
        return undefined;
    }, [currentDraftJson, draftPhase, saveDraft]);

    // Also saved when the tab is hidden, when the page is left, and shortly before an idle logout
    useEffect(() => {
        if (!draftsEnabled) return undefined;
        const onHidden = () => { if (document.visibilityState === 'hidden') saveDraft(); };
        document.addEventListener('visibilitychange', onHidden);
        window.addEventListener('pagehide', saveDraftOnLeave);
        const stopListening = onSessionEnding(saveDraft);
        return () => {
            document.removeEventListener('visibilitychange', onHidden);
            window.removeEventListener('pagehide', saveDraftOnLeave);
            stopListening();
            saveDraftOnLeave(); // the dashboard closes (e.g. Log Out)
        };
    }, [draftsEnabled, saveDraft, saveDraftOnLeave]);

    const clockTime = (at) => new Date(at).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
    // PTE courses with an open or approved application can't be chosen again (shown with the reason)
    const blockedCodes = useMemo(() => blockedCourseCodes(myApplications), [myApplications]);
    const courseOptionLabel = (c) => {
        const label = t('student_target_course_chip', { code: c.course_code, name: c.course_name, credits: c.credits });
        const status = blockedCodes[normalizeCourseCode(c.course_code)];
        if (!status) return label;
        return t(status === 'approved' ? 'student_course_already_approved' : 'student_course_already_applied', { course: label });
    };

    const parseCourses = (jsonStringOrArray) => {
        if (!jsonStringOrArray) return [];
        if (Array.isArray(jsonStringOrArray)) return jsonStringOrArray;
        try { return JSON.parse(jsonStringOrArray); } catch (e) { return []; }
    };

    // Row Management
    const handleAddCourseRow = () => { if (fulfilledCourses.length < LIMITS.fulfilledCourses) setFulfilledCourses([...fulfilledCourses, newCourseRow()]); };
    // Removing a row also deletes its evidence from storage. At least one row always stays.
    // Rows with content are confirmed first; if the evidence can't be deleted, the row stays.
    const handleRemoveCourseRow = async (id) => {
        const row = fulfilledCourses.find(c => c.id === id);
        if (!row || fulfilledCourses.length <= 1) return;
        const files = [row.file, row.syllabus_file].filter(Boolean);
        if (rowHasContent(row) && !window.confirm(t(files.length ? 'student_remove_course_confirm_file' : 'student_remove_course_confirm'))) return;
        for (const file of files) {
            try {
                await http.delete(getUploadEndpoint(file));
            } catch (err) {
                console.error('Could not delete a file of the course', err);
                setFieldError(`row:${id}:file`, t('student_evidence_remove_failed'));
                return;
            }
        }
        if (syllabusRowId === id) { setSyllabusRowId(null); setSyllabusFile(null); }
        setFulfilledCourses(list => list.filter(c => c.id !== id));
        dropFieldErrors(`row:${id}:`);
        if (activeUploadId === id) { setActiveUploadId(null); setHighlightFile(null); }
    };
    const handleCourseChange = (id, field, value) => {
        setFulfilledCourses(fulfilledCourses.map(c => c.id === id ? { ...c, [field]: value } : c));
        setFieldError(`row:${id}:${field}`, '');
        // The credit limit depends on the system, so a new system also clears the credits error
        if (field === 'credit_system') { setFieldError(`row:${id}:credits`, ''); setFieldError(`row:${id}:credit_system_other`, ''); }
    };

    // Institutions
    const handleAddInstitution = () => { if (institutions.length < LIMITS.institutions) setInstitutions([...institutions, newInstitution()]); };
    const handleInstitutionChange = (key, field, value) => {
        setInstitutions(institutions.map(i => i.key === key ? { ...i, [field]: value } : i));
        setFieldError(`inst:${key}:${field}`, '');
        // A duplicate is reported on the name, but changing the country can also resolve it
        if (field === 'country') setFieldError(`inst:${key}:name`, '');
    };
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
        dropFieldErrors(`inst:${key}:`);
    };

    // Grading-system document: uploaded as soon as it is chosen (no highlighter).
    // Replacing uploads the new file first and deletes the old one only after that worked.
    const handleGradingFileChosen = async (key, file) => {
        if (!file) return;
        // Checked before uploading, with the same rules and messages as the server
        const problem = await checkFile(file, MAX_MB.unchanged);
        if (problem) { setGradingState(key, { message: t(`errors.${problem.code}`, problem.params || {}) }); return; }
        setGradingState(key, { uploading: true });
        try {
            const formData = new FormData();
            formData.append('kind', 'unchanged');
            formData.append('file', file);
            const data = await http.post('uploads', { body: formData, timeout: false }).json();
            const current = institutionsRef.current.find((i) => i.key === key);
            if (!current) {
                // The institution was removed while uploading: don't leave the new file behind
                http.delete(getUploadEndpoint(data.fileName)).catch((err) => console.error('Could not delete unused upload', err));
                return;
            }
            const previous = current.grading_file;
            rememberName(data);
            setInstitutions((list) => list.map((i) => (i.key === key ? { ...i, grading_file: data.fileName } : i)));
            setGradingState(key, {});
            setFieldError(`inst:${key}:grading_file`, '');
            if (previous) {
                http.delete(getUploadEndpoint(previous)).catch((err) => console.error('Could not delete replaced grading document', err));
            }
        } catch (err) {
            setGradingState(key, { message: getErrorMessage(err, t, 'student_upload_failed') });
        }
    };

    // --- Syllabi (one per fulfilled course, when the syllabus rule applies) ---
    const setSyllabusState = (rowId, state) => setSyllabusStatus((prev) => ({ ...prev, [rowId]: state }));
    const chooseSyllabus = (rowId) => { syllabusPickRow.current = rowId; syllabusInput.current?.click(); };
    const handleSyllabusChosen = async (file) => {
        const rowId = syllabusPickRow.current;
        if (!file || !rowId) return;
        // A syllabus must be highlighted: PDF, JPG or PNG, opened in the highlighter
        const problem = await checkFile(file, MAX_MB.highlighterOriginal);
        if (problem) { setSyllabusState(rowId, { message: t(`errors.${problem.code}`, problem.params || {}) }); return; }
        setSyllabusState(rowId, {});
        setSyllabusRowId(rowId);
        setSyllabusFile(file);
    };
    // The highlighted syllabus is uploaded and linked to its course; a replaced one is deleted afterwards
    const uploadSyllabus = async (rowId, blob, fileName) => {
        const tooLarge = tooLargeToUpload(blob, MAX_MB.highlighted);
        if (tooLarge) { setSyllabusState(rowId, { message: t(`errors.${tooLarge.code}`, tooLarge.params) }); return; }
        setSyllabusState(rowId, { uploading: true });
        try {
            const formData = new FormData();
            formData.append('kind', 'highlighted');
            formData.append('file', blob, fileName);
            const data = await http.post('uploads', { body: formData, timeout: false }).json();
            const row = rowsRef.current.find((c) => c.id === rowId);
            if (!row) {
                http.delete(getUploadEndpoint(data.fileName)).catch((err) => console.error('Could not delete unused upload', err));
                return;
            }
            rememberName(data);
            setFulfilledCourses((list) => list.map((c) => (c.id === rowId ? { ...c, syllabus_file: data.fileName } : c)));
            setFieldError(`row:${rowId}:syllabus_file`, '');
            setSyllabusState(rowId, {});
            setSyllabusRowId(null);
            setSyllabusFile(null);
            if (row.syllabus_file) http.delete(getUploadEndpoint(row.syllabus_file)).catch((err) => console.error('Could not delete replaced syllabus', err));
        } catch (err) {
            setSyllabusState(rowId, { message: getErrorMessage(err, t, 'student_upload_failed') });
        }
    };
    const removeSyllabus = async (rowId, file) => {
        try {
            await http.delete(getUploadEndpoint(file));
            setFulfilledCourses((list) => list.map((c) => (c.id === rowId ? { ...c, syllabus_file: null } : c)));
            setSyllabusState(rowId, {});
        } catch (err) {
            setSyllabusState(rowId, { message: getErrorMessage(err, t, 'file_remove_failed') });
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
            setResubmitHighlightFile(null);
        } else {
            setHighlightFile(null);
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
            setFieldError(`row:${courseId}:file`, getErrorMessage(err, t, 'file_remove_failed'));
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
            setUploadStatus(getErrorMessage(err, t, 'file_remove_failed'));
        }
    };

    // Toggle Uploader for a specific case
    const triggerUploadForCourse = (id) => { 
        if (activeUploadId === id) {
            setActiveUploadId(null); 
        } else {
            setActiveUploadId(id); 
            setHighlightFile(null); 
        }
    };

    // A chosen syllabus: PDFs and images open in the highlighter; other types are attached as they are
    // A chosen file is checked (PDF, JPG or PNG; up to 50 MB, since only the saved pages are uploaded)
    // and then opened in the highlighter. For a transcript a highlight is required; in "add missing
    // info" it is optional, and without highlights the file is uploaded unchanged.
    const handleFileSelect = async (e, isResubmit = false) => {
        const file = e.target.files[0];
        e.target.value = ''; // the same file can be chosen again
        if (!file) return;
        const problem = await checkFile(file, MAX_MB.highlighterOriginal);
        if (problem) {
            if (isResubmit) setResubmitHighlightFile(null); else setHighlightFile(null);
            setUploadStatus(t(`errors.${problem.code}`, problem.params || {}));
            return;
        }
        setUploadStatus('');
        if (isResubmit) setResubmitHighlightFile(file); else setHighlightFile(file);
    };

    // The highlighter's finished file is uploaded like any evidence. kind is 'highlighted'
    // (up to 15 MB), or 'unchanged' when "add missing info" saves a file without highlights (10 MB).
    const uploadHighlighted = (blob, fileName, isResubmit, kind = 'highlighted') => {
        const tooLarge = tooLargeToUpload(blob, kind === 'highlighted' ? MAX_MB.highlighted : MAX_MB.unchanged);
        if (tooLarge) { setUploadStatus(t(`errors.${tooLarge.code}`, tooLarge.params)); return undefined; }
        setUploadStatus(t('student_upload_saving'));
        const formData = new FormData();
        formData.append('kind', kind);
        formData.append('file', blob, fileName);
        return executeUpload(formData, isResubmit);
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
                    setResubmitHighlightFile(null); 
                } else {
                    // The row was removed while uploading: don't leave the new file behind
                    if (!rowsRef.current.some(c => c.id === targetRowId)) {
                        http.delete(getUploadEndpoint(data.fileName)).catch((err) => console.error('Could not delete unused upload', err));
                        return;
                    }
                    rememberName(data);
                    setFulfilledCourses(list => list.map(c => c.id === targetRowId ? { ...c, file: data.fileName } : c));
                    setFieldError(`row:${targetRowId}:file`, '');
                    setTimeout(() => { setHighlightFile(null); setActiveUploadId(null); }, 1000);
                }
                setUploadStatus(t('student_upload_saved'));
                setTimeout(() => setUploadStatus(''), 2000);
            }
        } catch (err) { setUploadStatus(getErrorMessage(err, t, 'student_upload_failed')); }
    }

    // The programme has no target courses yet (e.g. before the admin imports them): nothing to apply for
    const noCourses = coursesLoaded && courses.length === 0;
    const canSubmit = isSubmissionsOpen && !noCourses;

    // Step 1: the browser runs the server's rules; if all is well, the summary opens (nothing is sent yet)
    const handleSubmitApplication = () => {
        if (!isSubmissionsOpen) return setSubmitStatus(t('student_submissions_closed', 'Submissions are currently closed.'));
        if (noCourses) return setSubmitStatus(t('student_no_courses_for_programme'));
        setSubmitSuccess(false);

        // Institution keys -> positions, credits -> numbers (see applicationForm.js).
        // With any problem nothing is sent.
        const { body, map } = currentSubmission();
        const problems = validateSubmission(body, isCountryCode);
        if (problems.length > 0) return showErrors(problems.map((e) => [e.field, translateError(e)]), map);
        // Same order as the server: then the syllabus rule (needs the chosen course's credits)
        if (syllabusReasons(body.fulfilled_courses, Number(targetCourse.credits)).length > 0) {
            const missing = missingSyllabi(body.fulfilled_courses);
            if (missing.length > 0) return showErrors(missing.map((e) => [e.field, translateError(e)]), map);
        }

        lastSubmitMap.current = map;
        setFieldErrors({});
        setShowErrorSummary(false);
        setSubmitStatus('');
        setSummaryOpen(true);
        return undefined;
    };

    // The success message takes focus when it appears
    useEffect(() => {
        if (submitSuccess && studentTab === 'dashboard') successRef.current?.focus();
    }, [submitSuccess, studentTab]);

    // Closing the summary puts keyboard focus back on the Submit button
    const closeSummary = () => {
        setSummaryOpen(false);
        setTimeout(() => submitButtonRef.current?.focus(), 0);
    };

    // Step 2: "Confirm and submit" in the summary sends the application
    const confirmSubmit = async () => {
        // The form can't change while the summary is open, so this is exactly what was shown
        const { body } = currentSubmission();
        setSummaryBusy(true);
        // Pending draft changes are saved first, so no autosave can arrive after the submit
        // (the server deletes the draft when it stores the application)
        await saveDraft();
        try {
            setSubmitStatus(t('student_submit_saving'));
            // Only the course ids: the server checks them against the student's programme
            // and stores their code, name and credits itself
            const data = await http.post('applications', { json: body }).json();
            
            if (data.success) {
                setSummaryOpen(false);
                setInstitutions([newInstitution()]);
                setFulfilledCourses([newCourseRow()]);
                setGradingStatus({});
                setFieldErrors({});
                setShowErrorSummary(false);
                setSyllabusStatus({}); setSyllabusRowId(null); setSyllabusFile(null);
                setSelectedCourses([]); setActiveUploadId(null); setHighlightFile(null); setSubmitStatus(''); setStudentNote('');
                fetchMyApplications(); 
                setStudentTab('dashboard');
                setSubmitSuccess(true); // shown at the top of "My Status" instead of a pop-up
                // The server has deleted the draft; the emptied form must not be saved again
                lastSavedDraft.current = NOTHING_SAVED;
                setDraftStatus(null);
                setDraftNotices([]);
            }
        } catch (err) {
            // The server still refused: back to the form, where the errors appear under their fields
            closeSummary();
            const message = getErrorMessage(err, t, 'student_submission_failed');

            if (getErrorCode(err) === 'COURSE_NOT_IN_PROGRAMME') {
                // The course list changed since the page loaded (e.g. a new import): reload it,
                // keep the chosen courses that still exist and say which ones were removed
                const fresh = await fetchCourses();
                const freshIds = new Set((fresh || []).map(c => c.id));
                const removed = fresh ? selectedCourses.filter(c => !freshIds.has(c.id)) : [];
                if (fresh) setSelectedCourses(selectedCourses.filter(c => freshIds.has(c.id)));
                const text = removed.length
                    ? `${message} ${t('student_courses_removed', { courses: removed.map(c => c.course_code).join(', ') })}`
                    : message;
                return showErrors([['target_course_ids', text]], lastSubmitMap.current);
            }

            // Field-level server errors go under their fields; anything else under Submit
            // Applied for this course meanwhile (e.g. in another tab): refresh, so the picker shows it
            if (getErrorCode(err) === 'ALREADY_APPLIED') fetchMyApplications();
            const byField = Object.entries(getFieldErrors(err, t));
            if (byField.length > 0) return showErrors(byField, lastSubmitMap.current);
            setSubmitStatus(message);
        } finally {
            setSummaryBusy(false);
        }
    };

    const submitResubmission = async () => {
        if (!isSubmissionsOpen) return alert(t('student_submissions_closed', 'Submissions are currently closed.'));
        if (resubmitFiles.length === 0 && resubmitNote.trim() === '') return alert(t('student_resubmit_missing_info_alert'));
        // Same note rule as the server: shown under the note, nothing sent
        const noteProblem = checkNote(resubmitNote);
        if (noteProblem) { setResubmitNoteError(t(`errors.${noteProblem.code}`, noteProblem.params || {})); return undefined; }
        setResubmitNoteError('');
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
        } catch (err) {
            // A note error from the server goes under the note, anything else into the status line
            if (getFieldErrors(err, t).student_resubmit_note) setResubmitNoteError(getFieldErrors(err, t).student_resubmit_note);
            else setUploadStatus(getErrorMessage(err, t, 'student_resubmission_failed'));
        }
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
                    {/* After a successful submit: a message here instead of a browser pop-up.
                        It gets keyboard focus (so screen readers read it), and can be closed. */}
                    {submitSuccess && (
                        <div role="status" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', backgroundColor: 'var(--surface)', borderLeft: '5px solid var(--success-accent)', padding: '10px 15px', borderRadius: '5px', marginBottom: '15px', fontWeight: 'bold' }}>
                            <span ref={successRef} tabIndex={-1}>✓ {t('student_submission_success')}</span>
                            <button type="button" onClick={() => setSubmitSuccess(false)} aria-label={t('notice_close')} title={t('notice_close')} style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', lineHeight: 1, color: 'inherit' }}>×</button>
                        </div>
                    )}
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
                            onChange={(e) => { setResubmitNote(e.target.value); setResubmitNoteError(''); }}
                            rows="3"
                            aria-invalid={resubmitNoteError ? true : undefined}
                            aria-describedby={resubmitNoteError ? 'resubmit-note-counter resubmit-note-error' : 'resubmit-note-counter'}
                            style={{ width: '100%', padding: '10px', borderRadius: '5px', border: resubmitNoteError ? '2px solid var(--danger-border)' : '1px solid var(--border-strong)', boxSizing: 'border-box' }}
                            placeholder="Explain what you have updated or attach new highlighted files below..."
                        />
                        <NoteCounter id="resubmit-note-counter" text={resubmitNote} t={t} />
                        {resubmitNoteError && <p id="resubmit-note-error" style={{ color: 'var(--error-text)', fontSize: '12px', fontWeight: 'bold', margin: '4px 0 0 0' }}>{resubmitNoteError}</p>}
                        <div style={{ marginBottom: '15px' }} />

                        <label style={{ fontWeight: 'bold', color: 'var(--link)', display: 'block', marginBottom: '8px' }}>Upload Additional Evidence:</label>
                        <div style={{ backgroundColor: 'var(--surface-2)', padding: '15px', border: '2px dashed var(--orange)', borderRadius: '5px', marginBottom: '20px' }}>
                            <input type="file" accept={ACCEPT} onChange={(e) => handleFileSelect(e, true)} style={{ marginBottom: '4px' }}/>
                            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 10px 0' }}>{t('student_file_hint', { max: MAX_MB.highlighterOriginal })}</p>
                            
                            {resubmitHighlightFile && (
                                <Suspense fallback={<p role="status">{t('student_highlighter_loading')}</p>}>
                                    {/* Missing information can be a transcript or a syllabus, so the longer (syllabus) limit applies */}
                                    <EvidenceHighlighter file={resubmitHighlightFile} kind="syllabus" highlightRequired={false} onSave={(blob, name, kind) => uploadHighlighted(blob, name, true, kind)} onCancel={() => clearUploadSelection(true)} />
                                </Suspense>
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
                            <button onClick={() => { setResubmitModal({ isOpen: false, app: null }); setResubmitHighlightFile(null); setResubmitNote(''); setResubmitFiles([]); }} style={{ padding: '10px 15px', cursor: 'pointer', border: '1px solid var(--border-strong)', borderRadius: '4px' }}>{t('student_cancel')}</button>
                            <button onClick={submitResubmission} style={{ padding: '10px 15px', cursor: 'pointer', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>{t('student_resubmit_button')}</button>
                        </div>
                    </div>
                </div>
            )}

            {/* SUBMIT NEW APPLICATION TAB */}
            {studentTab === 'submit' && (
                <div style={{ backgroundColor: 'var(--success-surface)', padding: '20px', borderRadius: '10px', border: '2px solid var(--success-border)' }}>
                    <h2 style={{ marginTop: 0, color: 'var(--link)' }}>{t('student_new_application_title')}</h2>

                    {/* Draft: what was restored or removed, or why autosave is paused */}
                    <div role="status" aria-live="polite">
                        {(draftNotices.length > 0 || draftPhase === 'failed') && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', backgroundColor: 'var(--info-surface)', border: '1px solid var(--info-border)', color: 'var(--info-text)', padding: '10px 15px', borderRadius: '5px', marginBottom: '15px' }}>
                                <ul style={{ margin: 0, paddingLeft: '18px' }}>
                                    {draftPhase === 'failed' && <li>{t('student_draft_load_failed')}</li>}
                                    {draftNotices.map(({ key, params }) => (
                                        <li key={key}>{t(key, key === 'student_draft_restored' ? { time: clockTime(params.time) } : params)}</li>
                                    ))}
                                </ul>
                                {draftNotices.length > 0 && (
                                    <button type="button" onClick={() => setDraftNotices([])} aria-label={t('notice_close')} title={t('notice_close')} style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', lineHeight: 1, color: 'inherit' }}>×</button>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Previous institutions: entered once, then chosen on each course row */}
                    <section aria-labelledby="institutions-title" style={{ backgroundColor: 'var(--surface)', padding: '15px', borderRadius: '5px', marginBottom: '20px' }}>
                        <h3 id="institutions-title" tabIndex={-1} style={{ margin: '0 0 5px 0', color: 'var(--link)' }}>{t('student_institutions_title')}</h3>
                        {renderFieldError('institutions')}
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
                                        <input {...fieldProps(`inst:${inst.key}:name`)} type="text" value={inst.name} onChange={(e) => handleInstitutionChange(inst.key, 'name', e.target.value)} style={inputStyle(`inst:${inst.key}:name`)} onBlur={(e) => checkField(`inst:${inst.key}:name`, e.target.value)} />
                                        {renderFieldError(`inst:${inst.key}:name`)}
                                    </div>
                                    <div>
                                        <label htmlFor={`inst-country-${inst.key}`} style={fieldLabelStyle}>{t('student_institution_country')}</label>
                                        <select {...fieldProps(`inst:${inst.key}:country`)} value={inst.country} onChange={(e) => handleInstitutionChange(inst.key, 'country', e.target.value)} style={inputStyle(`inst:${inst.key}:country`)} onBlur={(e) => checkField(`inst:${inst.key}:country`, e.target.value)}>
                                            <option value="">{t('student_country_placeholder')}</option>
                                            {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                                        </select>
                                        {renderFieldError(`inst:${inst.key}:country`)}
                                    </div>
                                </div>

                                {/* Grading-system document: one per institution, no highlighting */}
                                <div style={{ marginTop: '12px' }}>
                                    <span id={`inst-grading-label-${inst.key}`} style={fieldLabelStyle}>{t('student_grading_doc_label')}</span>
                                    <p id={`inst-grading-help-${inst.key}`} style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 6px 0' }}>{t('student_grading_doc_help')} {t('student_file_hint', { max: MAX_MB.unchanged })}</p>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                                        {/* Translated button; the browser's own "Choose file" input stays hidden */}
                                        <button
                                            type="button" disabled={gradingStatus[inst.key]?.uploading}
                                            onClick={() => gradingInputs.current[inst.key]?.click()}
                                            id={`inst-grading-btn-${inst.key}`}
                                            aria-describedby={`inst-grading-label-${inst.key} inst-grading-help-${inst.key}${fieldErrors[`inst:${inst.key}:grading_file`] ? ` inst-grading-btn-${inst.key}-error` : ''}`}
                                            style={{ padding: '8px 12px', backgroundColor: inst.grading_file ? 'var(--accent)' : 'var(--blue)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                                        >
                                            {inst.grading_file ? t('student_grading_doc_replace') : t('student_grading_doc_upload')}
                                        </button>
                                        {inst.grading_file && (
                                            <>
                                                <span style={{ fontSize: '13px', color: 'var(--link-alt)', fontWeight: 'bold', wordBreak: 'break-all' }}>📄 {displayName(inst.grading_file)}</span>
                                                <a href="#open-file" onClick={(e) => handleOpenFile(e, inst.grading_file)} style={{ fontSize: '12px', color: 'var(--success-accent)', fontWeight: 'bold' }}>{t('student_open_file')}</a>
                                                <button type="button" disabled={gradingStatus[inst.key]?.uploading} onClick={() => handleRemoveGradingFile(inst.key, inst.grading_file)} style={{ padding: '6px 10px', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>{t('student_remove_file')}</button>
                                            </>
                                        )}
                                    </div>
                                    {renderFieldError(`inst:${inst.key}:grading_file`)}
                                    <input
                                        ref={(el) => { gradingInputs.current[inst.key] = el; }}
                                        type="file" accept={ACCEPT} tabIndex={-1} style={{ display: 'none' }}
                                        // Cleared after each choice, so the same file can be chosen again
                                        onChange={(e) => { handleGradingFileChosen(inst.key, e.target.files[0]); e.target.value = ''; }}
                                    />
                                    {gradingStatus[inst.key]?.uploading && <p role="status" style={{ color: 'var(--link)', fontWeight: 'bold', margin: '6px 0 0 0' }}>{t('student_grading_doc_uploading')}</p>}
                                    {gradingStatus[inst.key]?.message && <p role="alert" style={{ color: 'var(--error-text)', fontWeight: 'bold', margin: '6px 0 0 0' }}>{gradingStatus[inst.key].message}</p>}
                                </div>
                            </div>
                        ))}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                            <button type="button" onClick={handleAddInstitution} disabled={institutions.length >= LIMITS.institutions} aria-describedby={institutions.length >= LIMITS.institutions ? 'max-institutions-hint' : undefined} style={{ padding: '8px 12px', backgroundColor: 'var(--grey)', color: 'white', border: 'none', borderRadius: '5px', cursor: institutions.length >= LIMITS.institutions ? 'not-allowed' : 'pointer', opacity: institutions.length >= LIMITS.institutions ? 0.6 : 1, fontWeight: 'bold' }}>{t('student_add_institution')}</button>
                            {institutions.length >= LIMITS.institutions && <span id="max-institutions-hint" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('student_max_institutions', { max: LIMITS.institutions })}</span>}
                        </div>
                    </section>
                    
                    <div id="fulfilled-courses-start" tabIndex={-1}>{renderFieldError('fulfilled_courses')}</div>
                    {fulfilledCourses.map((course, index) => (
                        <div key={course.id} style={{ backgroundColor: 'var(--surface)', padding: '15px', borderRadius: '5px', marginBottom: '15px', position: 'relative', borderLeft: course.file ? '5px solid var(--accent)' : '5px solid var(--red)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                                <h4 style={{ margin: 0, color: 'var(--link)' }}>{t('student_fulfilled_course_heading', { n: index + 1 })}</h4>
                                {/* At least one row always stays, so the only row has no remove button */}
                                {fulfilledCourses.length > 1 && (
                                    <button type="button" onClick={() => handleRemoveCourseRow(course.id)} aria-label={t('student_remove_course_aria', { n: index + 1 })} style={{ padding: '5px 10px', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}>{t('student_remove_course')}</button>
                                )}
                            </div>
                            
                            <div style={{ marginBottom: '10px' }}>
                                <label htmlFor={`row-inst-${course.id}`} style={fieldLabelStyle}>{t('student_course_institution')}</label>
                                <select {...fieldProps(`row:${course.id}:institution`)} value={course.institutionKey} onChange={(e) => handleCourseChange(course.id, 'institutionKey', e.target.value)} style={inputStyle(`row:${course.id}:institution`)} onBlur={(e) => checkField(`row:${course.id}:institution`, e.target.value)}>
                                    <option value="">{t('student_course_institution_placeholder')}</option>
                                    {institutions.map((inst, i) => <option key={inst.key} value={inst.key}>{institutionLabel(inst, i)}</option>)}
                                </select>
                                {renderFieldError(`row:${course.id}:institution`)}
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '10px' }}>
                                <div>
                                    <label htmlFor={`row-name-${course.id}`} style={fieldLabelStyle}>{t('student_fulfilled_course_label')}</label>
                                    <input {...fieldProps(`row:${course.id}:course_name`)} type="text" value={course.course_name} onChange={(e) => handleCourseChange(course.id, 'course_name', e.target.value)} style={inputStyle(`row:${course.id}:course_name`)} onBlur={(e) => checkField(`row:${course.id}:course_name`, e.target.value)} />
                                    {renderFieldError(`row:${course.id}:course_name`)}
                                </div>
                                <div>
                                    <label htmlFor={`row-code-${course.id}`} style={fieldLabelStyle}>{t('student_course_code_label')}</label>
                                    <input {...fieldProps(`row:${course.id}:course_code`)} type="text" value={course.course_code} onChange={(e) => handleCourseChange(course.id, 'course_code', e.target.value)} style={inputStyle(`row:${course.id}:course_code`)} onBlur={(e) => checkField(`row:${course.id}:course_code`, e.target.value)} />
                                    {renderFieldError(`row:${course.id}:course_code`)}
                                </div>
                                <div>
                                    <label htmlFor={`row-credits-${course.id}`} style={fieldLabelStyle}>{t('student_total_credits_label')} {creditsMatch && <span style={{ color: 'var(--ok-text)' }}>✅</span>}</label>
                                    <input {...fieldProps(`row:${course.id}:credits`)} type="number" step="0.5" min="0.5" inputMode="decimal" value={course.credits} onChange={(e) => handleCourseChange(course.id, 'credits', e.target.value)} style={inputStyle(`row:${course.id}:credits`)} onBlur={(e) => checkField(`row:${course.id}:credits`, e.target.value)} />
                                    {renderFieldError(`row:${course.id}:credits`)}
                                </div>
                                <div>
                                    <label htmlFor={`row-system-${course.id}`} style={fieldLabelStyle}>{t('student_credit_system')}</label>
                                    <select {...fieldProps(`row:${course.id}:credit_system`)} value={course.credit_system} onChange={(e) => handleCourseChange(course.id, 'credit_system', e.target.value)} style={inputStyle(`row:${course.id}:credit_system`)} onBlur={(e) => checkField(`row:${course.id}:credit_system`, e.target.value)}>
                                        <option value="">{t('student_credit_system_placeholder')}</option>
                                        {CREDIT_SYSTEMS.map((system) => <option key={system} value={system}>{t(`student_credit_system_${system}`)}</option>)}
                                    </select>
                                    {renderFieldError(`row:${course.id}:credit_system`)}
                                </div>
                                {course.credit_system === 'OTHER' && (
                                    <div>
                                        <label htmlFor={`row-system-other-${course.id}`} style={fieldLabelStyle}>{t('student_credit_system_other_label')}</label>
                                        <input {...fieldProps(`row:${course.id}:credit_system_other`)} type="text" value={course.credit_system_other} onChange={(e) => handleCourseChange(course.id, 'credit_system_other', e.target.value)} style={inputStyle(`row:${course.id}:credit_system_other`)} onBlur={(e) => checkField(`row:${course.id}:credit_system_other`, e.target.value)} />
                                        {renderFieldError(`row:${course.id}:credit_system_other`)}
                                    </div>
                                )}
                                <div>
                                    <label htmlFor={`row-grade-${course.id}`} style={fieldLabelStyle}>{t('student_grade_label')}</label>
                                    <input {...fieldProps(`row:${course.id}:grade`)} type="text" value={course.grade} onChange={(e) => handleCourseChange(course.id, 'grade', e.target.value)} style={inputStyle(`row:${course.id}:grade`)} onBlur={(e) => checkField(`row:${course.id}:grade`, e.target.value)} />
                                    {renderFieldError(`row:${course.id}:grade`)}
                                </div>
                            </div>
                            
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <button type="button" id={`row-evidence-btn-${course.id}`} aria-describedby={fieldErrors[`row:${course.id}:file`] ? `row-evidence-btn-${course.id}-error` : undefined} onClick={() => triggerUploadForCourse(course.id)} style={{ padding: '8px 12px', backgroundColor: course.file ? 'var(--accent)' : 'var(--blue)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                                    {activeUploadId === course.id ? t('student_close_uploader') : (course.file ? t('student_replace_evidence') : t('student_upload_transcript'))}
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
                                                <span style={{ fontSize: '13px', color: 'var(--link-alt)', fontWeight: 'bold', wordBreak: 'break-all' }}>{displayName(course.file)}</span>
                                            )}
                                            <span style={{ fontSize: '12px', color: 'var(--success-accent)', fontWeight: 'bold' }}>{t('student_open_file')}</span>
                                        </a>
                                        <button onClick={() => handleDeleteUploadedFile(course.id, course.file)} style={{ padding: '6px 10px', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>{t('student_remove_file')}</button>
                                    </div>
                                )}
                            </div>

                            {renderFieldError(`row:${course.id}:file`)}

                            {/* --- INLINE UPLOADER --- */}
                            {activeUploadId === course.id && (
                                <div style={{ backgroundColor: 'var(--surface-2)', padding: '15px', border: '2px dashed var(--blue)', borderRadius: '5px', marginTop: '15px' }}>
                                    <h4 style={{ marginTop: 0 }}>{t('student_upload_evidence_title')}</h4>
                                    <input type="file" accept={ACCEPT} onChange={(e) => handleFileSelect(e, false)} />
                                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>{t('student_file_hint', { max: MAX_MB.highlighterOriginal })}</p>
                                    
                                    {highlightFile && (
                                        <Suspense fallback={<p role="status">{t('student_highlighter_loading')}</p>}>
                                            <EvidenceHighlighter file={highlightFile} kind="transcript" onSave={(blob, name, kind) => uploadHighlighted(blob, name, false, kind)} onCancel={() => clearUploadSelection(false)} />
                                        </Suspense>
                                    )}

                                    {uploadStatus && <p style={{ color: 'var(--link)', fontWeight: 'bold', marginTop: '10px' }}>{uploadStatus}</p>}
                                </div>
                            )}
                        </div>
                    ))}

                    <div style={{ marginBottom: '20px' }}>
                        <button type="button" onClick={handleAddCourseRow} disabled={fulfilledCourses.length >= LIMITS.fulfilledCourses} aria-describedby={fulfilledCourses.length >= LIMITS.fulfilledCourses ? 'max-courses-hint' : undefined} style={{ padding: '10px', backgroundColor: 'var(--grey)', color: 'white', border: 'none', borderRadius: '5px', cursor: fulfilledCourses.length >= LIMITS.fulfilledCourses ? 'not-allowed' : 'pointer', opacity: fulfilledCourses.length >= LIMITS.fulfilledCourses ? 0.6 : 1, fontWeight: 'bold', width: '100%' }}>{t('student_add_course')}</button>
                        {fulfilledCourses.length >= LIMITS.fulfilledCourses && <p id="max-courses-hint" style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '5px 0 0 0', textAlign: 'center' }}>{t('student_max_courses', { max: LIMITS.fulfilledCourses })}</p>}
                    </div>

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ fontWeight: 'bold', color: 'var(--link)' }}>{t('student_select_pte_courses_label')}</label>
                        {noCourses ? (
                            <p role="status" style={{ backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)', padding: '10px', borderRadius: '5px', margin: '5px 0 0' }}>{t('student_no_courses_for_programme')}</p>
                        ) : (
                        <select {...fieldProps('target_course_ids')} value="" onChange={(e) => { const course = courses.find(c => c.id === parseInt(e.target.value)); if (course) { setSelectedCourses([course]); setFieldError('target_course_ids', ''); } }} style={{ width: '100%', padding: '10px', marginTop: '5px', border: '1px solid var(--border-strong)', borderRadius: '4px' }}>
                            <option value="">{t('student_select_pte_courses_placeholder')}</option>
                            {courses.map(c => <option key={c.id} value={c.id} disabled={Boolean(blockedCodes[normalizeCourseCode(c.course_code)])}>{courseOptionLabel(c)}</option>)}
                        </select>
                        )}
                        {renderFieldError('target_course_ids')}
                        <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                            {selectedCourses.map(sc => (
                                <span key={sc.id} style={{ backgroundColor: 'var(--teal)', color: 'white', padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold', maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere', display: 'inline-flex', alignItems: 'center' }}>
                                    {t('student_target_course_chip', { code: sc.course_code, name: sc.course_name, credits: sc.credits })}
                                    <button type="button" aria-label={t('student_remove_target_course', { code: sc.course_code })} onClick={() => setSelectedCourses(selectedCourses.filter(c => c.id !== sc.id))} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', marginLeft: '5px', flexShrink: 0 }}>×</button>
                                </span>
                            ))}
                        </div>
                    </div>

                    {/* Syllabi: needed when the syllabus rule applies; one per fulfilled course, linked to its row */}
                    {(syllabusNeeded || fulfilledCourses.some((c) => c.syllabus_file)) && (
                        // A light box with a coloured stripe (not a yellow background): the highlighter opens inside it,
                        // and its yellow marks must stay easy to see
                        <section aria-labelledby="syllabus-title" style={{ backgroundColor: 'var(--surface)', borderLeft: `5px solid ${syllabusNeeded && !allSyllabiAttached ? 'var(--orange)' : 'var(--accent)'}`, padding: '15px', borderRadius: '5px', marginBottom: '20px' }}>
                            <h3 id="syllabus-title" style={{ margin: '0 0 6px 0', fontSize: '15px', color: syllabusNeeded && !allSyllabiAttached ? 'var(--warning-text)' : 'var(--link)' }}>
                                {syllabusNeeded && !allSyllabiAttached ? `⚠ ${t('student_syllabus_needed_title')}` : t('student_syllabi_attached')}
                            </h3>
                            <p style={{ fontSize: '12px', margin: '0 0 6px 0', opacity: 0.85 }}>{t('student_file_hint', { max: MAX_MB.highlighterOriginal })}</p>
                            {syllabusNeeded && (
                                <ul style={{ margin: '0 0 10px 0', paddingLeft: '20px' }}>
                                    {syllabusNeededFor.map((code) => <li key={code}>{t(`student_syllabus_reason_${code}`)}</li>)}
                                </ul>
                            )}
                            {fulfilledCourses.map((course, index) => (
                                <div key={course.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                                        <strong style={{ fontSize: '13px' }}>{t('student_syllabus_for_course', { n: index + 1, name: course.course_name.trim() || '…' })}</strong>
                                        <button
                                            type="button" id={`row-syllabus-btn-${course.id}`}
                                            disabled={syllabusStatus[course.id]?.uploading}
                                            aria-describedby={fieldErrors[`row:${course.id}:syllabus_file`] ? `row-syllabus-btn-${course.id}-error` : undefined}
                                            onClick={() => chooseSyllabus(course.id)}
                                            style={{ padding: '6px 10px', backgroundColor: course.syllabus_file ? 'var(--accent)' : 'var(--blue)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                                        >
                                            {course.syllabus_file ? t('student_replace_syllabus') : t('student_upload_syllabus_button')}
                                        </button>
                                        {course.syllabus_file && (
                                            <>
                                                <span style={{ fontSize: '13px', fontWeight: 'bold', wordBreak: 'break-all' }}>📄 {displayName(course.syllabus_file)}</span>
                                                <a href="#open-file" onClick={(e) => handleOpenFile(e, course.syllabus_file)} style={{ fontSize: '12px', color: 'var(--success-accent)', fontWeight: 'bold' }}>{t('student_open_file')}</a>
                                                <button type="button" onClick={() => removeSyllabus(course.id, course.syllabus_file)} style={{ padding: '5px 10px', backgroundColor: 'var(--red)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}>{t('student_remove_file')}</button>
                                            </>
                                        )}
                                    </div>
                                    {renderFieldError(`row:${course.id}:syllabus_file`)}
                                    {syllabusStatus[course.id]?.uploading && <p role="status" style={{ margin: '6px 0 0 0', fontWeight: 'bold' }}>{t('student_upload_saving')}</p>}
                                    {syllabusStatus[course.id]?.message && <p role="alert" style={{ margin: '6px 0 0 0', color: 'var(--error-text)', fontWeight: 'bold' }}>{syllabusStatus[course.id].message}</p>}
                                    {syllabusRowId === course.id && syllabusFile && (
                                        <Suspense fallback={<p role="status">{t('student_highlighter_loading')}</p>}>
                                            <EvidenceHighlighter file={syllabusFile} kind="syllabus" onSave={(blob, name) => uploadSyllabus(course.id, blob, name)} onCancel={() => { setSyllabusRowId(null); setSyllabusFile(null); }} />
                                        </Suspense>
                                    )}
                                </div>
                            ))}
                            <input
                                ref={syllabusInput} type="file" accept={ACCEPT} tabIndex={-1} style={{ display: 'none' }}
                                onChange={(e) => { handleSyllabusChosen(e.target.files[0]); e.target.value = ''; }}
                            />
                        </section>
                    )}

                    <div style={{ marginBottom: '20px' }}>
                        <label htmlFor="student-note" style={{ fontWeight: 'bold', color: 'var(--link)' }}>{t('student_notes_label')}</label>
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '5px 0' }}>{t('student_notes_help')}</p>
                        <textarea 
                            {...fieldProps('student_note')}
                            value={studentNote}
                            onChange={(e) => { setStudentNote(e.target.value); setFieldError('student_note', ''); }}
                            onBlur={(e) => checkField('student_note', e.target.value)}
                            rows="4"
                            aria-describedby={fieldErrors.student_note ? 'student-note-counter student-note-error' : 'student-note-counter'}
                            style={{ width: '100%', padding: '10px', borderRadius: '5px', border: fieldErrors.student_note ? '2px solid var(--danger-border)' : '1px solid var(--border-strong)', boxSizing: 'border-box' }}
                            placeholder={t('student_notes_placeholder')}
                        />
                        <NoteCounter id="student-note-counter" text={studentNote} t={t} />
                        {renderFieldError('student_note')}
                    </div>

                    {!isSubmissionsOpen && (
                        <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', border: '1px solid var(--danger-border)', padding: '15px', borderRadius: '5px', marginBottom: '20px' }}>
                            {t('student_submissions_closed', 'Submissions are currently closed. Please check back later.')}
                        </div>
                    )}

                    {/* Autosave state. Only a failed save is announced: "saved" every few seconds would be noise. */}
                    {draftPhase === 'ready' && draftStatus?.kind !== 'error' && (
                        <p style={{ fontSize: '12px', textAlign: 'right', margin: '0 0 6px 0', color: 'var(--text-muted)' }}>
                            {draftStatus?.kind === 'saving' && t('student_draft_saving')}
                            {draftStatus?.kind === 'saved' && t('student_draft_saved', { time: clockTime(draftStatus.at) })}
                            {!draftStatus && t('student_draft_hint')}
                        </p>
                    )}
                    <div role="alert">
                        {draftStatus?.kind === 'error' && (
                            <p style={{ fontSize: '12px', textAlign: 'right', margin: '0 0 6px 0', color: 'var(--error-text)', fontWeight: 'bold' }}>
                                {draftStatus.code === 'DRAFT_TOO_LARGE' ? t('errors.DRAFT_TOO_LARGE', { max: DRAFT_MAX_KB }) : t('student_draft_save_failed')}
                            </p>
                        )}
                    </div>
                    <button
                        ref={submitButtonRef}
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
                    {summaryOpen && targetCourse && (
                        <SubmitSummary
                            institutions={institutions}
                            rows={fulfilledCourses}
                            targetCourse={targetCourse}
                            syllabusReasons={syllabusNeededFor || []}
                            note={studentNote}
                            countryName={countryName}
                            institutionLabel={institutionLabel}
                            fileName={displayName}
                            busy={summaryBusy}
                            onBack={closeSummary}
                            onConfirm={confirmSubmit}
                        />
                    )}

                    {/* Announced by screen readers when it changes */}
                    <div role="status" aria-live="polite">
                        {showErrorSummary && errorCount > 0 && <p style={{ color: 'var(--error-text)', textAlign: 'center', fontWeight: 'bold', marginTop: '10px' }}>{t('student_form_has_errors', { count: errorCount })}</p>}
                        {submitStatus && <p style={{ color: 'var(--error-text)', textAlign: 'center', fontWeight: 'bold', marginTop: '10px' }}>{submitStatus}</p>}
                    </div>
                </div>
            )}
        </div>
    );
};

export default StudentDashboard;