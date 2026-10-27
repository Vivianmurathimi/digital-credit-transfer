import React, { useEffect, useState } from 'react';
import { fetchFileBlob } from '../secureFiles';

// An <img> for evidence files: loads the image with the login token,
// then shows it from a temporary local copy (freed again when it leaves the screen).
const SecureImage = ({ fileName, alt, style, onClick, title }) => {
    const [src, setSrc] = useState(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let objectUrl = null;
        let cancelled = false;
        setSrc(null);
        setFailed(false);

        fetchFileBlob(fileName)
            .then((blob) => {
                if (cancelled) return;
                objectUrl = URL.createObjectURL(blob);
                setSrc(objectUrl);
            })
            .catch(() => { if (!cancelled) setFailed(true); });

        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [fileName]);

    // Same size box while loading or if the file cannot be shown, so the layout never jumps
    if (!src) {
        return (
            <span
                title={title || alt}
                onClick={onClick}
                style={{ ...style, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '35px', backgroundColor: 'var(--surface-2)', fontSize: '16px' }}
            >
                {failed ? '⚠️' : '⏳'}
            </span>
        );
    }

    return <img src={src} alt={alt} style={style} onClick={onClick} title={title} />;
};

export default SecureImage;
