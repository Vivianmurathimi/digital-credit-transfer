import http from './http';

// Downloads a PDF the server makes on request (round 2 Group 1: a reviewer's book, one
// application's PDF) and saves it under the server's file name. The server checks who may have it.
// Throws the request error (unpack it with errorMessage.js unpackBlobError).
const fileNameOf = (response, fallback) => {
    const header = response.headers.get('content-disposition') || '';
    const star = header.match(/filename\*=UTF-8''([^;]+)/i);
    if (star) { try { return decodeURIComponent(star[1]); } catch { /* use the plain one */ } }
    const plain = header.match(/filename="?([^";]+)"?/i);
    return plain ? plain[1] : fallback;
};

const downloadPdf = async (path, fallbackName) => {
    const response = await http.get(path, { timeout: 180000 });
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileNameOf(response, fallbackName);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
};

export default downloadPdf;
