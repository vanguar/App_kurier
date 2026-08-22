import { navigationUrl, pointHasPostalAddress, pointNavOptions } from '../src/core/navigation.js';

let passed = 0;
let failed = 0;
function ok(name, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? `: ${detail}` : ''}`); failed++; }
}

const addressPoint = {
  address: { street: 'Kastanienallee', houseNumber: '2' },
  coords: { lat: 53.8916, lng: 13.04096 },
  coordinateManual: false,
};
const label = 'Kastanienallee 2, 17109 Demmin';
const automatic = pointNavOptions(addressPoint);

ok('postal street + house is a concrete address', pointHasPostalAddress(addressPoint));
ok('automatic map pin yields to the postal address', automatic.addressOnly === true);

const google = navigationUrl('google', addressPoint.coords, label, automatic);
ok('Google receives the address, not automatic coordinates',
  google.includes('destination=Kastanienallee%202%2C%2017109%20Demmin') && !google.includes('53.8916'));

const waze = navigationUrl('waze', addressPoint.coords, label, automatic);
ok('Waze receives an address query, not an ll pin', waze.includes('q=Kastanienallee%202%2C%2017109%20Demmin') && !waze.includes('ll='));

const manualPoint = { ...addressPoint, coordinateManual: true };
const manualWaze = navigationUrl('waze', manualPoint.coords, label, pointNavOptions(manualPoint));
ok('manually saved entrance uses exact GPS', manualWaze.includes('ll=53.8916,13.04096'));

const fieldPoint = { address: {}, coords: { lat: 53.8, lng: 13.1 }, coordinateManual: false };
const fieldGoogle = navigationUrl('google', fieldPoint.coords, 'Field stop', pointNavOptions(fieldPoint));
ok('address-less field stop falls back to exact coordinates', fieldGoogle.includes('destination=53.8,13.1'));

if (failed) {
  console.error(`\n✗ ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n✓ ALL PASS — ${passed} passed, 0 failed`);
