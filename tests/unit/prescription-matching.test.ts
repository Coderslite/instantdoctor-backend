import { describe, expect, it } from 'vitest';
import { matchScore, strengthsIn } from '../../src/modules/prescriptions/prescription-matching.js';

const amox = { name: 'Amoxicillin', strength: '500mg', form: 'capsule' };

describe('prescription matching', () => {
  it('reads strengths in any spacing', () => {
    expect(strengthsIn('Amoxicillin 500 mg caps')).toEqual(['500mg']);
    expect(strengthsIn('Co-amoxiclav 500mg/125mg')).toEqual(['500mg', '125mg']);
  });

  it('matches the same medicine and strength', () => {
    expect(matchScore(amox, 'Amoxicillin 500mg Capsules x21')).not.toBeNull();
    expect(matchScore(amox, 'AMOXICILLIN CAPS (no strength on label)')).not.toBeNull();
  });

  it('rejects other medicines and other strengths', () => {
    expect(matchScore(amox, 'Paracetamol 500mg')).toBeNull();
    expect(matchScore(amox, 'Amoxicillin 250mg Capsules')).toBeNull();
  });

  it('prefers an exact strength over an unlabelled pack', () => {
    const exact = matchScore(amox, 'Amoxicillin 500mg Capsules')!;
    const plain = matchScore(amox, 'Amoxicillin Capsules')!;
    expect(exact).toBeGreaterThan(plain);
  });

  it('needs every word of a multi-word name', () => {
    const item = { name: 'Vitamin C', strength: null, form: null };
    expect(matchScore({ ...item, name: 'Artemether Lumefantrine' }, 'Artemether/Lumefantrine 20/120mg')).not.toBeNull();
    expect(matchScore({ ...item, name: 'Artemether Lumefantrine' }, 'Artesunate 50mg')).toBeNull();
  });
});
