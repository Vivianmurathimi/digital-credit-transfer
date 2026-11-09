import http from './http';
import { saveSession } from './session';

// The admin acting as a student or reviewer (admin round Group 1). The server issues a session
// token for that person which also carries the admin's id; Exit ends it on the server and gives
// the admin's own session back. Nothing else is stored in the browser.

// Starts acting as the user with this id (superadmin only)
export const startActing = async (userId) => {
    const { token, role } = await http.post('acting/start', { json: { userId } }).json();
    saveSession(token, role);
};

// Ends the acting session and restores the admin's own session
export const exitActing = async () => {
    const { token, role } = await http.post('acting/exit').json();
    saveSession(token, role);
};
