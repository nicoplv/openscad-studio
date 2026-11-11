import { buildShareUrl, parseShareContext } from '../shareRouting';

describe('shareRouting', () => {
  it('parses share URLs without a presentation mode', () => {
    expect(parseShareContext('/s/abc12345', '')).toEqual({ shareId: 'abc12345' });
  });

  it('keeps legacy mode links working while ignoring the mode', () => {
    expect(parseShareContext('/s/abc12345/', '?mode=editor')).toEqual({
      shareId: 'abc12345',
    });
    expect(parseShareContext('/s/abc12345/', '?mode=customizer')).toEqual({
      shareId: 'abc12345',
    });
  });

  it('returns null for unrelated paths', () => {
    expect(parseShareContext('/settings', '')).toBeNull();
  });

  it('builds mode-free share URLs', () => {
    expect(buildShareUrl('https://openscad-studio.pages.dev', 'abc12345')).toBe(
      'https://openscad-studio.pages.dev/s/abc12345'
    );
  });
});
