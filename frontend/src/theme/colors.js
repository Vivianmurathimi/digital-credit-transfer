// Reading the theme's colours where a CSS variable can't be used directly (admin round Group 8):
// a canvas fill style or a pdf-lib colour needs the actual value. The values themselves are only in
// theme/theme.css; this reads them from the page at the moment they are needed.

const root = () => (typeof document === 'undefined' ? null : document.documentElement);

// '--highlight-mark' -> '#ffe600' (as written in theme.css); '' when the theme isn't loaded (tests)
export const cssColor = (name) => {
    const element = root();
    return element ? getComputedStyle(element).getPropertyValue(name).trim() : '';
};

// '#ffe600' -> { r: 1, g: 0.9, b: 0 } for pdf-lib's rgb(); null when it isn't a #rrggbb colour
export const hexToRgb01 = (hex) => {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
    return match ? { r: parseInt(match[1], 16) / 255, g: parseInt(match[2], 16) / 255, b: parseInt(match[3], 16) / 255 } : null;
};
