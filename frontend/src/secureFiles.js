import api from './api';

// Evidence files need the login token, so plain <img src> and <a href> links cannot load them.
// These helpers fetch a file WITH the token and hand the browser a temporary local copy.

export const getUploadEndpoint = (fileName) => `/api/uploads/${encodeURIComponent(fileName)}`;

// Downloads one file as a Blob (throws if not allowed or not found)
export const fetchFileBlob = async (fileName) => {
    const res = await api.get(getUploadEndpoint(fileName), { responseType: 'blob' });
    return res.data;
};

// Opens a file in a new tab. The tab is opened straight away (inside the click),
// otherwise the browser's popup blocker would stop it after the download finishes.
export const openSecureFile = async (fileName) => {
    const tab = window.open('', '_blank');
    try {
        const url = URL.createObjectURL(await fetchFileBlob(fileName));
        if (tab) tab.location.href = url;
        else window.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 60 * 1000); // free the copy once the tab has loaded it
    } catch (err) {
        if (tab) tab.close();
        throw err;
    }
};

// Saves a file to the user's computer under its stored name
export const downloadSecureFile = async (fileName) => {
    const url = URL.createObjectURL(await fetchFileBlob(fileName));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
};
