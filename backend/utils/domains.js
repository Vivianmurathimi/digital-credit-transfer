// Allowed email domains for student registration (admin round Group 3). The list lives in the
// database (allowed_domains), managed by the superadmin; no domain is written in the code.

const MAX_DOMAIN_LENGTH = 253;
// Host name labels: letters, digits and hyphens (not at either end), at least one dot.
// Same rule as the database check (migration 015).
const DOMAIN_PATTERN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// "  @Students.Example " -> "students.example" (a leading @ is allowed in the admin's input)
const normalizeDomain = (value) => (typeof value === 'string' ? value.trim().toLowerCase().replace(/^@/, '') : '');

const isValidDomain = (domain) => domain.length > 0 && domain.length <= MAX_DOMAIN_LENGTH
    && DOMAIN_PATTERN.test(domain) && domain.split('.').every((label) => label.length <= 63);

// The domain of an address: everything after the only "@" ("" when there isn't exactly one)
const domainOf = (email) => {
    const parts = String(email || '').trim().toLowerCase().split('@');
    return parts.length === 2 && parts[0] ? parts[1] : '';
};

/**
 * Whether a student may register with this address: its domain EXACTLY matches a listed one
 * (an address @sub.x.hu does not count for x.hu).
 * @param {{ query: Function }} db
 */
const isAllowedStudentEmail = async (db, email) => {
    const domain = domainOf(email);
    if (!isValidDomain(domain)) return false;
    const { rows } = await db.query('SELECT 1 FROM allowed_domains WHERE domain = $1', [domain]);
    return rows.length > 0;
};

module.exports = { normalizeDomain, isValidDomain, domainOf, isAllowedStudentEmail, MAX_DOMAIN_LENGTH };
