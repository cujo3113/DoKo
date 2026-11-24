// Tests für den Ratgeber (public/advisor.js)
import assert from 'node:assert/strict';
import * as A from '../public/advisor.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const { scoreSolo, scoreNormal } = A._internal;

t('Solo-Abrechnung: gewonnen 8 + 4 je weitere Zeile', () => {
  assert.deepEqual(scoreSolo(130, 6, 0), { win: true, me: 0, others: 8 });
  assert.deepEqual(scoreSolo(160, 7, 0), { win: true, me: 0, others: 12 });             // keine 90
  assert.deepEqual(scoreSolo(160, 7, 1), { win: true, me: 0, others: 16 });             // + keine 90 angesagt
});
t('Solo-Abrechnung: verloren mit gegen die Alten, dreifach', () => {
  assert.deepEqual(scoreSolo(100, 4, 0), { win: false, me: 36, others: 0 });            // (8+4)*3
  assert.deepEqual(scoreSolo(130, 6, 1), { win: false, me: 48, others: 0 });            // keine 90 angesagt, nicht geschafft
  assert.deepEqual(scoreSolo(80, 3, 0), { win: false, me: 48, others: 0 });             // + keine 90
});
t('Normalspiel-Abrechnung', () => {
  assert.equal(scoreNormal(130, 4, false), 1);
  assert.equal(scoreNormal(130, 4, true), 2);                                           // gegen die Alten
  assert.equal(scoreNormal(240, 0, false), 5);                                          // schwarz
});
t('Damensolo-Blatt: Empfehlung Damensolo', () => {
  const h = ['CQ0', 'SQ0', 'SQ1', 'HQ0', 'DQ0', 'CJ0', 'CA0', 'SA0', 'ST0', 'HA0'];
  const s = A.summarize(h, A.simulateAll(h, 0, 600));
  assert.equal(s.rec.kind, 'solo');
  assert.equal(s.rec.type, 'solo_damen');
});
t('Durchschnittsblatt ohne Alte: normal spielen, Kontra', () => {
  const h = ['HT0', 'HT1', 'DQ0', 'CJ0', 'SJ0', 'CA0', 'CA1', 'SA0', 'SA1', 'HK0'];
  const s = A.summarize(h, A.simulateAll(h, 2, 600));
  assert.equal(s.rec.kind, 'normal');
  assert.equal(s.normal.party, 'Kontra');
  assert.ok(s.normal.win > 0.45 && s.normal.win < 0.8, `Gewinnchance ${s.normal.win}`);
  assert.ok(s.solos.every((x) => x.limit < 0));
});
t('Beide Kreuz-Damen: Hochzeit, Hinweis auf stille Hochzeit', () => {
  const h = ['CQ0', 'CQ1', 'HT0', 'SQ0', 'HQ0', 'CJ0', 'DA0', 'CA0', 'SA0', 'HA0'];
  const s = A.summarize(h, A.simulateAll(h, 1, 600));
  assert.equal(s.rec.kind, 'hochzeit');
  assert.ok(s.notes.some((x) => x.includes('Stille Hochzeit')));
});
t('Schmeißen bei sehr schwachem Blatt', () => {
  const h = ['DK0', 'DK1', 'CK0', 'SK0', 'HK0', 'CT0', 'ST0', 'HA0', 'CA0', 'SA0'];
  const s = A.summarize(h, A.simulateAll(h, 3, 600), { schmeissen: 'höchster Trumpf ist kleiner als der Karo-Bube' });
  assert.ok(['schmeissen', 'solo'].includes(s.rec.kind), s.rec.kind);
});
t('Gleiches Blatt und Platz liefern dieselben Zahlen', () => {
  const h = ['HT0', 'CQ0', 'SQ0', 'HQ0', 'CJ0', 'DA0', 'DT0', 'CA0', 'SA0', 'HK0'];
  const a = A.summarize(h, A.simulateAll(h, 1, 300)), b = A.summarize(h, A.simulateAll(h, 1, 300));
  assert.equal(a.normal.win, b.normal.win);
});
console.log(`Ratgeber: ${n} Tests bestanden.`);
