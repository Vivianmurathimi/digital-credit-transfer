import { evaluateSession } from './session';

// An unsigned token with this payload (the frontend only reads it; the server checks the signature)
const tokenFor = (payload) => {
    const part = (value) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signature`;
};
const now = Date.now();
const seconds = Math.floor(now / 1000);
const base = { iat: seconds, exp: seconds + 30 * 60, sessionStart: seconds };

test('a normal session shows the account\'s own dashboard, not acting', () => {
    const { valid, view } = evaluateSession({ token: tokenFor({ ...base, id: 1, role: 'superadmin' }), now });
    expect(valid).toBe(true);
    expect(view).toEqual({ userId: 1, role: 'superadmin', name: '', acting: false });
});

test('an acting session (admin round Group 1) shows the person\'s dashboard with the banner name', () => {
    const token = tokenFor({ ...base, id: 7, role: 'student', acting: { sessionId: 3, actorId: 1, name: 'Anna Kovács' } });
    const { view } = evaluateSession({ token, now });
    expect(view).toEqual({ userId: 7, role: 'student', name: 'Anna Kovács', acting: true });
});

test('acting claims on a superadmin token are ignored (the server never issues such a token)', () => {
    const token = tokenFor({ ...base, id: 1, role: 'superadmin', acting: { sessionId: 3, actorId: 1, name: 'x' } });
    expect(evaluateSession({ token, now }).view.acting).toBe(false);
});
