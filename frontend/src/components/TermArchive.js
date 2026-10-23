import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useTranslation } from 'react-i18next';

const formatSize = (bytes) => (bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`);

const inputStyle = { padding: '10px', border: '1px solid var(--link)', borderRadius: '5px', boxSizing: 'border-box', fontSize: '14px' };
const cellStyle = { padding: '10px', textAlign: 'left', verticalAlign: 'middle' };

// Super admin card: build a PDF "book" of one semester's applications and download saved books
const TermArchive = () => {
    const { t, i18n } = useTranslation();
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [archives, setArchives] = useState([]);
    const [isGenerating, setIsGenerating] = useState(false);
    const [message, setMessage] = useState(null); // { type: 'success' | 'error', text }

    const fetchArchives = useCallback(async () => {
        try {
            const res = await api.get('/api/archive');
            if (res.data.success) setArchives(res.data.archives);
        } catch (err) {
            console.error('Error fetching term books', err);
            setMessage({ type: 'error', text: t('archive_error_list') });
        }
    }, [t]);

    useEffect(() => {
        fetchArchives();
    }, [fetchArchives]);

    const handleGenerate = async () => {
        if (!from || !to || from > to) {
            setMessage({ type: 'error', text: t('archive_error_dates') });
            return;
        }
        setIsGenerating(true);
        setMessage(null);
        try {
            const res = await api.post('/api/archive/generate', { from, to });
            if (res.data.success) {
                const { applications, pages } = res.data.archive;
                setMessage({ type: 'success', text: t('archive_generated', { count: applications, pages }) });
                fetchArchives();
            }
        } catch (err) {
            console.error('Error generating term book', err);
            setMessage({ type: 'error', text: t('archive_error_generate') });
        } finally {
            setIsGenerating(false);
        }
    };

    // The download route needs the login token, so fetch the file and save it from the browser
    const handleDownload = async (name) => {
        try {
            const res = await api.get(`/api/archive/${encodeURIComponent(name)}/download`, { responseType: 'blob' });
            const url = window.URL.createObjectURL(res.data);
            const link = document.createElement('a');
            link.href = url;
            link.download = name;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Error downloading term book', err);
            setMessage({ type: 'error', text: t('archive_error_download') });
        }
    };

    return (
        <div style={{ backgroundColor: 'var(--surface)', padding: '20px', borderRadius: '10px', border: '2px solid var(--link)', marginTop: '30px' }}>
            <h2 style={{ marginTop: 0, color: 'var(--link)' }}>📚 {t('archive_title')}</h2>
            <p style={{ fontSize: '14px', color: 'var(--text-muted)', marginBottom: '20px' }}>{t('archive_description')}</p>

            <div style={{ display: 'flex', gap: '15px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '15px' }}>
                <label style={{ display: 'flex', flexDirection: 'column', fontWeight: 'bold', color: 'var(--link)', gap: '5px' }}>
                    {t('archive_from')}
                    <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} style={inputStyle} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', fontWeight: 'bold', color: 'var(--link)', gap: '5px' }}>
                    {t('archive_to')}
                    <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} style={inputStyle} />
                </label>
                <button
                    onClick={handleGenerate}
                    disabled={isGenerating}
                    style={{ padding: '11px 20px', fontSize: '15px', fontWeight: 'bold', cursor: isGenerating ? 'wait' : 'pointer', backgroundColor: isGenerating ? 'var(--grey)' : 'var(--brand)', color: 'white', border: 'none', borderRadius: '5px' }}
                >
                    {isGenerating ? t('archive_generating') : t('archive_generate')}
                </button>
            </div>

            {message && (
                <div style={{
                    padding: '10px', borderRadius: '5px', marginBottom: '15px', fontWeight: 'bold',
                    backgroundColor: message.type === 'success' ? 'var(--success-bg)' : 'var(--danger-bg)',
                    color: message.type === 'success' ? 'var(--success-text)' : 'var(--danger-text)',
                }}>
                    {message.text}
                </div>
            )}

            <h3 style={{ color: 'var(--link)', marginBottom: '10px' }}>{t('archive_saved_title')}</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', border: '2px solid var(--border)' }}>
                <thead>
                    <tr style={{ backgroundColor: 'var(--brand)', color: 'white' }}>
                        <th style={cellStyle}>{t('archive_col_semester')}</th>
                        <th style={cellStyle}>{t('archive_col_applications')}</th>
                        <th style={cellStyle}>{t('archive_col_pages')}</th>
                        <th style={cellStyle}>{t('archive_col_size')}</th>
                        <th style={cellStyle}>{t('archive_col_created')}</th>
                        <th style={{ ...cellStyle, textAlign: 'center' }}>{t('archive_col_download')}</th>
                    </tr>
                </thead>
                <tbody>
                    {archives.length === 0 ? (
                        <tr><td colSpan="6" style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>{t('archive_none')}</td></tr>
                    ) : archives.map((archive) => (
                        <tr key={archive.name} style={{ borderBottom: '2px solid var(--border)' }}>
                            <td style={{ ...cellStyle, fontWeight: 'bold' }}>{archive.from} – {archive.to}</td>
                            <td style={cellStyle}>{archive.applications}</td>
                            <td style={cellStyle}>{archive.pages}</td>
                            <td style={cellStyle}>{formatSize(archive.size)}</td>
                            <td style={{ ...cellStyle, fontSize: '13px', color: 'var(--text-secondary)' }}>
                                {new Date(archive.createdAt).toLocaleString(i18n.language)}
                            </td>
                            <td style={{ ...cellStyle, textAlign: 'center' }}>
                                <button
                                    onClick={() => handleDownload(archive.name)}
                                    style={{ padding: '6px 12px', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                                >
                                    📥 {t('archive_download')}
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

export default TermArchive;
