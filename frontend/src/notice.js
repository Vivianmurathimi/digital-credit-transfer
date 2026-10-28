// A tiny message bus for app-wide notices (e.g. "You are not allowed to do this.").
// Code outside React (the HTTP clients) calls showNotice; the Notice banner listens.

const listeners = new Set();

// `code` is a translation key under errors.* (e.g. 'FORBIDDEN_ROLE')
export const showNotice = (code) => {
    listeners.forEach((listener) => listener(code));
};

// Returns an unsubscribe function, for use in a React effect
export const onNotice = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};
