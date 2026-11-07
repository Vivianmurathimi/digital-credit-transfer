// The PTE final grades (reviewer Group 6), for the reviewer and the student side alike.
// The Hungarian name is always shown; English and German add their own name next to it.
export const FINAL_GRADES = [5, 4, 3, 2];
export const HUNGARIAN_GRADE_NAMES = { 5: 'jeles', 4: 'jó', 3: 'közepes', 2: 'elégséges' };

/**
 * "4 (jó)" in Hungarian, "4 (jó – good)" / "4 (jó – gut)" in English / German.
 * t: i18next's t; the local names are the grade_name_<n> keys.
 */
export const gradeText = (grade, t, language) => {
    const hu = HUNGARIAN_GRADE_NAMES[grade];
    if (!hu) return grade === null || grade === undefined ? '—' : String(grade);
    return String(language || '').startsWith('hu') ? `${grade} (${hu})` : `${grade} (${hu} – ${t(`grade_name_${grade}`)})`;
};
