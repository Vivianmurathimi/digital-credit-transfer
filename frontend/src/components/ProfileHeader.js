import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import http from '../http';
import { programmeName } from '../programmeName';

// The logged-in student's own details in the dashboard top bar (read-only:
// students can't change their programme). Shows nothing for other roles for now.
// Loaded fresh every time the dashboard opens; nothing is cached, so a new login
// in the same tab never sees the previous person's details.
const ProfileHeader = () => {
    const { t, i18n } = useTranslation();
    const [profile, setProfile] = useState(null);

    useEffect(() => {
        let active = true; // ignore an answer that arrives after the dashboard has closed
        http.get('me').json()
            .then((data) => { if (active) setProfile(data.user); })
            .catch((err) => console.error('Could not load profile', err)); // a 401 already logs out
        return () => { active = false; };
    }, []);

    if (!profile || profile.role !== 'student') return null;

    const row = { margin: 0, fontSize: '13px', color: 'var(--text-secondary)' };

    return (
        <section aria-label={t('profile_label')} style={{ textAlign: 'right', lineHeight: 1.4 }}>
            <p style={{ margin: 0, fontWeight: 'bold', color: 'var(--heading)' }}>{profile.name}</p>
            <p style={row}>{profile.email}</p>
            <p style={row}>{t('profile_neptun')}: <strong style={{ letterSpacing: '1px' }}>{profile.neptun_code}</strong></p>
            {profile.programme && (
                <p style={row}>{t('profile_programme')}: <strong>{programmeName(profile.programme, i18n)}</strong></p>
            )}
        </section>
    );
};

export default ProfileHeader;
