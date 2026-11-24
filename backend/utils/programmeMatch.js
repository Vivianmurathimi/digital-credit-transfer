// Keeping one programme from turning into two (fixes, Group 1b; migration 026). Used by the Neptun
// import (step 1: the programme chosen before the CSV; step 3: every row checked against it) and by
// the add-programme form, so both follow the same rules.
//
//   Names are compared after trimming, collapsing spaces, and ignoring case and accents:
//   "Civil  Engineering " = "civil engineering", "Építőmérnöki" = "Epitomernoki".
//   Codes are compared ignoring case. A programme's other codes (programme_aliases) count as its own.
//
// A new programme LOOKS LIKE an existing one when
//   same_code     its code is that programme's code or one of its other codes
//   similar_code  one code starts with the other ("CIV" / "CIVIL"), from PREFIX_MIN characters, so a
//                 very short code does not match everything
//   same_name     one of its names (any language) equals one of that programme's names

const LANGUAGES = ['hu', 'en', 'de'];
const PREFIX_MIN = 3;
const PROGRAMME_CODE = /^[A-Z0-9_-]{1,20}$/;
const MAX_NAME = 200;

const normalizeName = (text) => String(text ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
const normalizeCode = (code) => String(code ?? '').trim().toUpperCase();
const namesOf = (p) => LANGUAGES.map((l) => normalizeName(p[`name_${l}`])).filter(Boolean);

const startsAlike = (a, b) => {
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    return shorter.length >= PREFIX_MIN && longer.startsWith(shorter);
};

/**
 * Every programme with its other codes: [{ id, code, name_hu, name_en, name_de, status, aliases: [code] }]
 */
const loadProgrammes = async (db) => {
    const programmes = (await db.query('SELECT id, code, name_hu, name_en, name_de, status FROM programmes ORDER BY code')).rows;
    const aliases = (await db.query('SELECT programme_id, alias_code FROM programme_aliases ORDER BY alias_code')).rows;
    for (const p of programmes) p.aliases = aliases.filter((a) => a.programme_id === p.id).map((a) => a.alias_code);
    return programmes;
};

/**
 * The existing programmes a new programme looks like, each with its reasons, most alike first.
 * @param {{ code: string, name_hu?, name_en?, name_de? }} candidate
 * @param {Array} programmes  from loadProgrammes
 */
const findLookalikes = (programmes, candidate) => {
    const code = normalizeCode(candidate.code);
    const names = new Set(namesOf(candidate));
    const found = [];
    for (const p of programmes) {
        const codes = [p.code.toUpperCase(), ...p.aliases];
        const reasons = [];
        if (code && codes.includes(code)) reasons.push('same_code');
        else if (code && codes.some((c) => startsAlike(code, c))) reasons.push('similar_code');
        if (namesOf(p).some((n) => names.has(n))) reasons.push('same_name');
        if (reasons.length > 0) {
            found.push({ id: p.id, code: p.code, name_hu: p.name_hu, name_en: p.name_en, name_de: p.name_de, status: p.status, aliases: p.aliases, reasons });
        }
    }
    const weight = (l) => (l.reasons.includes('same_code') ? 3 : 0) + (l.reasons.includes('same_name') ? 2 : 0) + (l.reasons.includes('similar_code') ? 1 : 0);
    return found.sort((a, b) => weight(b) - weight(a) || a.code.localeCompare(b.code));
};

/**
 * Checks a new programme as typed: [code, message, field] or null. Names are trimmed; EN/DE optional.
 */
const checkNewProgramme = (input) => {
    if (!input || typeof input !== 'object') return ['INVALID_PROGRAMME', 'Give the new programme', 'programme'];
    const code = normalizeCode(input.code);
    if (!code) return ['MISSING_VALUE', 'The programme code is required', 'code'];
    if (!PROGRAMME_CODE.test(code)) return ['INVALID_PROGRAMME_CODE', 'Letters, digits, - and _ only, at most 20', 'code'];
    if (typeof input.name_hu !== 'string' || !input.name_hu.trim()) return ['MISSING_VALUE', 'The Hungarian name is required', 'name_hu'];
    for (const l of LANGUAGES) {
        const value = input[`name_${l}`];
        if (value !== undefined && value !== null && typeof value !== 'string') return ['INVALID_NAME', 'A name must be text', `name_${l}`];
        if (typeof value === 'string' && value.trim().length > MAX_NAME) return ['NAME_TOO_LONG', `At most ${MAX_NAME} characters`, `name_${l}`];
    }
    return null;
};

// The new programme as it will be saved: EN and DE fall back to the Hungarian name
const cleanNewProgramme = (input) => {
    const hu = input.name_hu.trim();
    return {
        code: normalizeCode(input.code),
        name_hu: hu,
        name_en: (typeof input.name_en === 'string' && input.name_en.trim()) || hu,
        name_de: (typeof input.name_de === 'string' && input.name_de.trim()) || hu,
    };
};

/**
 * Does a CSV programme (code and names, as in the file) mean the chosen programme? Its code is the
 * programme's code or one of its other codes, or one of its names equals one of the programme's.
 * @param {{ code, name_hu, name_en, name_de, aliases?: string[] }} chosen
 */
const rowMatches = (chosen, written) => {
    const code = normalizeCode(written.code);
    if (code === normalizeCode(chosen.code) || (chosen.aliases || []).includes(code)) return true;
    const mine = new Set(namesOf(chosen));
    return namesOf(written).some((n) => mine.has(n));
};

/**
 * Saves `code` as another code of the programme (inside the caller's transaction). Refused when the
 * code is already a programme's own code or another programme's alias. Returns { added } or { error }.
 */
const saveAlias = async (client, programmeId, code, actorId = null) => {
    const alias = normalizeCode(code);
    const owner = (await client.query(
        `SELECT p.id, p.code FROM programmes p WHERE upper(p.code) = $1
         UNION ALL SELECT p.id, p.code FROM programme_aliases a JOIN programmes p ON p.id = a.programme_id WHERE a.alias_code = $1`,
        [alias]
    )).rows[0];
    if (owner && owner.id === programmeId) return { added: 0 };
    if (owner) return { error: [409, 'ALIAS_TAKEN', `${alias} is already the code of ${owner.code}`, 'mismatches'], code: alias, owner: owner.code };
    await client.query('INSERT INTO programme_aliases (programme_id, alias_code, created_by) VALUES ($1, $2, $3)', [programmeId, alias, actorId]);
    return { added: 1 };
};

module.exports = {
    LANGUAGES, PREFIX_MIN, PROGRAMME_CODE, normalizeName, normalizeCode, loadProgrammes, findLookalikes,
    checkNewProgramme, cleanNewProgramme, rowMatches, saveAlias,
};
