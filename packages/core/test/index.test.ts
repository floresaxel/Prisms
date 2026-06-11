import { describe, expect, it } from 'vitest';

import { CORE_PACKAGE } from '../src/index';

describe('@prisms/core skeleton', () => {
  it('exports the package marker', () => {
    expect(CORE_PACKAGE).toBe('@prisms/core');
  });
});
