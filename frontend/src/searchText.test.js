// The Programmes & Courses search (fixes 3a):   npm test
import { courseMatches, matchesAny, programmeMatches } from './searchText';

const civil = { code: 'CIVIL', aliases: ['CIV'], name_hu: 'Építőmérnöki', name_en: 'Civil Engineering', name_de: 'Bauingenieurwesen' };

test('case and Hungarian accents are ignored, spaces too', () => {
    expect(matchesAny('epites', ['Építés'])).toBe(true);
    expect(matchesAny('OSZTOTT', ['osztott képzés'])).toBe(true);
    expect(matchesAny('kozet', ['Kőzettan'])).toBe(true);
    expect(matchesAny('kőzet', ['kozettan'])).toBe(true);
    expect(matchesAny('  civil   eng ', ['Civil Engineering'])).toBe(true);
    expect(matchesAny('mechanical', ['Civil Engineering'])).toBe(false);
});

test('an empty box shows everything', () => {
    expect(matchesAny('', ['anything'])).toBe(true);
    expect(matchesAny('   ', [])).toBe(true);
});

test('a programme matches by its code, its other codes and its names in every language', () => {
    expect(programmeMatches('civil', civil)).toBe(true);
    expect(programmeMatches('CIV', { ...civil, code: 'CE' })).toBe(true); // only through its other code
    expect(programmeMatches('epitomern', civil)).toBe(true);
    expect(programmeMatches('bauing', civil)).toBe(true);
    expect(programmeMatches('xyz', civil)).toBe(false);
    expect(programmeMatches('ce', { code: 'CE', name_en: 'X' })).toBe(true); // no aliases listed
});

test('a course matches by its code or its name', () => {
    const course = { course_code: 'PTE-101', course_name: 'Építéstechnológia' };
    expect(courseMatches('pte-1', course)).toBe(true);
    expect(courseMatches('epitestech', course)).toBe(true);
    expect(courseMatches('statika', course)).toBe(false);
});
