import { describe, expect, it } from 'vitest';
import { reusableLicense } from './destination-photo';

describe('destination image licensing', () => {
  it('accepts attribution/share-alike, CC0 and public-domain material', () => {
    expect(reusableLicense('CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0/')).toBe(true);
    expect(reusableLicense('CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/')).toBe(true);
    expect(reusableLicense('CC0', 'https://creativecommons.org/publicdomain/zero/1.0/')).toBe(true);
    expect(reusableLicense('Public domain', '')).toBe(true);
  });
  it('rejects restricted, unknown or misleading license links', () => {
    expect(reusableLicense('CC BY-NC', 'https://creativecommons.org/licenses/by-nc/4.0/')).toBe(false);
    expect(reusableLicense('CC BY-ND', 'https://creativecommons.org/licenses/by-nd/4.0/')).toBe(false);
    expect(reusableLicense('CC BY', 'https://creativecommons.org.example.com/licenses/by/4.0/')).toBe(false);
    expect(reusableLicense('All rights reserved', '')).toBe(false);
  });
});
