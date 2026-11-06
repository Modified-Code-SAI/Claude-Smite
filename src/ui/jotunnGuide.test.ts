import { describe, expect, it } from 'vitest';
import { JOTUNN, PARTS } from '../sim/Jotunn';
import { GUIDE_ROUNDS, guideHtml, guideLines, showsGuide } from './JotunnGuide';

describe('Jötunn rules card', () => {
  it('shows for a player\'s first rounds on a side, then stops', () => {
    expect(GUIDE_ROUNDS).toBe(2);
    expect(showsGuide(0)).toBe(true);
    expect(showsGuide(1)).toBe(true);
    expect(showsGuide(2)).toBe(false);
  });

  it('tells the gods where to hit, with the rules\' own numbers', () => {
    const g = guideLines('god');
    const all = [g.title, ...g.steps, g.foot].join(' ');
    expect(g.title).toBe('Bring down the Jötunn');
    expect(all).toContain('<b>knees</b>');
    expect(all).toContain(`×${PARTS.crown.mult}`);
    expect(all).toContain('<b>wrist</b>');
    expect(all).toContain(`${JOTUNN.braziersToWin} of the ${JOTUNN.braziers.length}`);
  });

  it('tells the giant what to smash and what to guard', () => {
    const g = guideLines('giant');
    const all = [g.title, ...g.steps, g.foot].join(' ');
    expect(g.title).toBe('You are the Jötunn');
    expect(all).toContain(`Smash ${JOTUNN.braziersToWin} of the ${JOTUNN.braziers.length} braziers`);
    expect(all).toContain('ice shrine');
    expect(all).toContain('<b>knees</b>');
  });

  it('draws the giant with its knees, crown and wrists marked', () => {
    const html = guideHtml('god');
    expect(html.match(/class="jg-mark/g)).toHaveLength(5);
    expect(html).toContain('jg-mark gold');
    expect(html).toContain('<ol><li>');
  });
});
