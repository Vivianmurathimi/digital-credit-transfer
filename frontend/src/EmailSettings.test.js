// The daily summary switches panel (migration 031):   npm test
// The requests are replaced by a fake (the real client, ky, is an ES module Jest doesn't load), so
// this checks only what the panel shows: the switches the server says apply, locked while acting.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import EmailSettings from './components/EmailSettings';
import http from './http';

jest.mock('./http', () => ({ __esModule: true, default: { get: jest.fn(), put: jest.fn() } }));
// Translations: the key itself, so the test reads which text is shown
jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key) => key }),
    initReactI18next: { type: '3rdParty', init: () => {} },
}));

const serverSays = (settings) => http.get.mockReturnValue({ json: () => Promise.resolve({ success: true, settings }) });
const switches = () => screen.queryAllByRole('checkbox');

afterEach(() => jest.clearAllMocks());

test('a reviewer: only the reviewer summary switch', async () => {
    serverSays({ reviewerSummary: true });
    render(<EmailSettings />);
    await waitFor(() => expect(switches()).toHaveLength(1));
    expect(screen.getByText('email_settings_reviewerSummary')).toBeInTheDocument();
    expect(screen.queryByText('email_settings_committeeSummary')).not.toBeInTheDocument();
    expect(switches()[0]).toBeChecked();
});

test('a committee member: only the committee summary switch, shown as off when it is off', async () => {
    serverSays({ committeeSummary: false });
    render(<EmailSettings />);
    await waitFor(() => expect(switches()).toHaveLength(1));
    expect(screen.getByText('email_settings_committeeSummary')).toBeInTheDocument();
    expect(switches()[0]).not.toBeChecked();
});

test('a reviewer on a committee: both switches, each on its own', async () => {
    serverSays({ reviewerSummary: true, committeeSummary: false });
    render(<EmailSettings />);
    await waitFor(() => expect(switches()).toHaveLength(2));
    expect(switches().map((box) => box.checked)).toEqual([true, false]);
    expect(switches().every((box) => !box.disabled)).toBe(true);
});

test('nobody with a switch (students, admins): no panel at all', async () => {
    serverSays({});
    const { container } = render(<EmailSettings />);
    await waitFor(() => expect(http.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
});

test('while the admin acts as the person: shown, locked, with the note', async () => {
    serverSays({ reviewerSummary: true, committeeSummary: true });
    render(<EmailSettings acting />);
    await waitFor(() => expect(switches()).toHaveLength(2));
    expect(switches().every((box) => box.disabled)).toBe(true);
    expect(screen.getByText('email_settings_acting')).toBeInTheDocument();
});
