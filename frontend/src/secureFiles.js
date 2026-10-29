import http from './http';
import { fileNameFromDisposition } from './fileRules';

// Evidence files need the login token, so plain <img src> and <a href> links cannot load them.
// These helpers fetch a file WITH the token and hand the browser a temporary local copy.

// Path for the shared http client (no leading slash: it is added after the /api prefix)
export const getUploadEndpoint = (fileName) => `uploads/${encodeURIComponent(fileName)}`;

// Downloads one file as a Blob (throws if not allowed or not found).
// No time limit: a big PDF on a slow connection may take longer than the usual 30 s.
// On an error ky has already read the { error, code } answer into err.data for getErrorMessage.
export const fetchFileBlob = (fileName) =>
    http.get(getUploadEndpoint(fileName), { timeout: false }).blob();

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

// Saves a file to the user's computer under the name the student chose (sent by the server,
// accents included); files from before Group 5 keep their stored name
export const downloadSecureFile = async (fileName) => {
    const response = await http.get(getUploadEndpoint(fileName), { timeout: false });
    const name = fileNameFromDisposition(response.headers.get('content-disposition')) || fileName;
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
};
