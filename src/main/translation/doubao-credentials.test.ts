import { describe, expect, it } from 'vitest';
import { doubaoAuthHeaders } from './doubao-credentials.js';

describe('doubaoAuthHeaders', () => {
  it('sends a new-console API Key as X-Api-Key', () => {
    expect(doubaoAuthHeaders({ apiKey: 'k', resourceId: 'r' })).toEqual({
      'X-Api-Key': 'k',
      'X-Api-Resource-Id': 'r'
    });
  });

  it('sends the old-console pair as App Key + Access Key', () => {
    expect(doubaoAuthHeaders({ appKey: 'a', accessKey: 'b', resourceId: 'r' })).toEqual({
      'X-Api-App-Key': 'a',
      'X-Api-Access-Key': 'b',
      'X-Api-Resource-Id': 'r'
    });
  });
});
