import assert from 'assert';
import { validateEmail, validatePassword, getAuthErrorMessage } from '../src/lib/authValidation.js';

console.log('🧪 Starting Email/Password Authentication & Validation Test Suite...\n');

let total = 0;
let passed = 0;

function run(name: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

// 1. Email format validation tests
run('validateEmail: rejects empty or null email', () => {
  assert.strictEqual(validateEmail('').valid, false);
  assert.strictEqual(validateEmail('   ').valid, false);
});

run('validateEmail: rejects malformed emails without domain or @ symbol', () => {
  assert.strictEqual(validateEmail('plainaddress').valid, false);
  assert.strictEqual(validateEmail('missingdomain@').valid, false);
  assert.strictEqual(validateEmail('@missingusername.com').valid, false);
  assert.strictEqual(validateEmail('user@domain').valid, false);
});

run('validateEmail: accepts valid RFC emails', () => {
  assert.strictEqual(validateEmail('player@gaminghub.ng').valid, true);
  assert.strictEqual(validateEmail('timiverse.io@gmail.com').valid, true);
  assert.strictEqual(validateEmail('user.name+tag@domain.co.uk').valid, true);
});

// 2. Password strength validation tests
run('validatePassword: rejects empty or undefined passwords', () => {
  assert.strictEqual(validatePassword('').valid, false);
});

run('validatePassword: rejects passwords shorter than 6 characters (Firebase Auth requirement)', () => {
  assert.strictEqual(validatePassword('12345').valid, false);
  assert.strictEqual(validatePassword('abc').valid, false);
});

run('validatePassword: accepts passwords with 6 or more characters', () => {
  assert.strictEqual(validatePassword('123456').valid, true);
  assert.strictEqual(validatePassword('GamingPass2026!').valid, true);
});

// 3. Firebase Auth error translation tests
run('getAuthErrorMessage: translates auth/user-not-found to user friendly text', () => {
  const msg = getAuthErrorMessage({ code: 'auth/user-not-found' });
  assert(msg.includes('No Gaming Hub player account found'));
});

run('getAuthErrorMessage: translates auth/wrong-password and invalid-credential', () => {
  const msg1 = getAuthErrorMessage({ code: 'auth/wrong-password' });
  const msg2 = getAuthErrorMessage({ code: 'auth/invalid-credential' });
  assert(msg1.includes('Incorrect email or password'));
  assert(msg2.includes('Incorrect email or password'));
});

run('getAuthErrorMessage: translates auth/email-already-in-use', () => {
  const msg = getAuthErrorMessage({ code: 'auth/email-already-in-use' });
  assert(msg.includes('already exists'));
});

run('getAuthErrorMessage: translates auth/operation-not-allowed with helpful guidance', () => {
  const msg = getAuthErrorMessage({ code: 'auth/operation-not-allowed' });
  assert(msg.includes('Firebase Console'));
});

console.log(`\n🎉 All ${passed}/${total} Email/Password Authentication & Validation tests passed successfully!\n`);
