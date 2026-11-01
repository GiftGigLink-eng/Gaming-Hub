import assert from 'assert';
import {
  firestoreRepo,
  RoomNotFoundError,
  RoomEndedError,
  ChatUnauthorizedError,
  RoomValidationError,
} from '../src/server/firestoreRepository.js';

console.log('🧪 Starting Chat Security & Membership Authorization Test Suite...\n');

let total = 0;
let passed = 0;

async function run(name: string, fn: () => Promise<void> | void) {
  total++;
  try {
    const res = fn();
    if (res instanceof Promise) await res;
    passed++;
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

async function runTestSuite() {
  const hostId = `host_chat_${Date.now()}`;
  const memberId = `member_chat_${Date.now()}`;
  const nonMemberId = `outsider_chat_${Date.now()}`;

  // 1. Create test room with host as initial participant
  const room = await firestoreRepo.createRoom(
    hostId,
    'HostGamer',
    'freefire',
    'Free Fire',
    'Chat Security Test Room'
  );

  // 2. Add member to room
  await firestoreRepo.joinRoom(room.id, memberId, 'MemberGamer');

  // 3. Send test message from host
  await firestoreRepo.sendMessage(room.id, hostId, 'HostGamer', 'Hello room members!');

  // Test 1: Authorized member can read chat messages
  await run('Authorized Room Member can read chat messages', async () => {
    const messages = await firestoreRepo.getMessages(room.id, memberId);
    assert(Array.isArray(messages), 'Messages must be returned as array');
    assert(messages.length >= 1, 'Messages must contain the sent message');
    assert.strictEqual(messages[0].text, 'Hello room members!');
  });

  // Test 2: Authorized host can read chat messages
  await run('Authorized Room Host can read chat messages', async () => {
    const messages = await firestoreRepo.getMessages(room.id, hostId);
    assert(Array.isArray(messages));
    assert.strictEqual(messages[0].text, 'Hello room members!');
  });

  // Test 3: Authenticated non-member is strictly rejected with ChatUnauthorizedError (HTTP 403)
  await run('Non-member is strictly rejected with ChatUnauthorizedError', async () => {
    let rejected = false;
    try {
      await firestoreRepo.getMessages(room.id, nonMemberId);
    } catch (err: any) {
      if (err instanceof ChatUnauthorizedError) {
        rejected = true;
      }
    }
    assert.strictEqual(rejected, true, 'Non-member must be denied message read access');
  });

  // Test 4: Unauthenticated or missing user ID is rejected with RoomValidationError
  await run('Missing user ID is rejected with RoomValidationError', async () => {
    let rejected = false;
    try {
      await firestoreRepo.getMessages(room.id, '');
    } catch (err: any) {
      if (err instanceof RoomValidationError) {
        rejected = true;
      }
    }
    assert.strictEqual(rejected, true, 'Empty user ID must be rejected');
  });

  // Test 5: Non-existent room is rejected with RoomNotFoundError (HTTP 404)
  await run('Non-existent room is rejected with RoomNotFoundError', async () => {
    let rejected = false;
    try {
      await firestoreRepo.getMessages('rm_non_existent_9999', memberId);
    } catch (err: any) {
      if (err instanceof RoomNotFoundError) {
        rejected = true;
      }
    }
    assert.strictEqual(rejected, true, 'Non-existent room must return RoomNotFoundError');
  });

  // Test 6: Ended room message read rejects active queries with RoomEndedError
  await run('Ended room rejects message queries with RoomEndedError', async () => {
    // Close the room
    await firestoreRepo.closeRoom(room.id, hostId);

    let rejected = false;
    try {
      await firestoreRepo.getMessages(room.id, memberId);
    } catch (err: any) {
      if (err instanceof RoomEndedError) {
        rejected = true;
      }
    }
    assert.strictEqual(rejected, true, 'Ended room must reject message reading with RoomEndedError');
  });

  console.log(`\n🎉 All ${passed}/${total} Chat Security & Authorization tests passed successfully!\n`);
}

runTestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
