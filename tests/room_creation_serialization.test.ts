import assert from 'assert';
import { MatchRoom, RoomVisibility } from '../src/types.js';

console.log('🧪 Starting Room Creation Circular JSON Serialization Regression Test Suite...\n');

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

// -------------------------------------------------------------
// SECTION 1: Exact Reproduction of the Circular JSON Defect
// -------------------------------------------------------------
run('Reproduction: Object.assign(room, { room, pin }) triggers circular JSON TypeError', () => {
  const legacyRoom: any = {
    id: 'rm_circular_test',
    title: 'Bug Reproduction Room',
    hostId: 'host_123',
    hostName: 'HostUser',
    visibility: 'private',
    accessCodeHash: 'scrypt$v1$...',
    maxParticipants: 4,
    participantCount: 1,
  };

  // The defective pattern previously executed in firestoreRepository:
  Object.assign(legacyRoom, { room: legacyRoom, pin: '123456' });

  // Self-reference check
  assert.strictEqual(legacyRoom.room, legacyRoom, 'Object.assign must have created a self-referential cycle');

  // Attempting to serialize with res.json({ success: true, room: result.room, pin: result.pin })
  let caughtError: any = null;
  try {
    JSON.stringify({ success: true, room: legacyRoom.room, pin: legacyRoom.pin });
  } catch (err: any) {
    caughtError = err;
  }

  assert(caughtError !== null, 'JSON.stringify must throw on circular structure');
  assert(
    caughtError.message.includes('Converting circular structure to JSON') &&
    caughtError.message.includes("property 'room' closes the circle"),
    `Error message must match exact report, got: ${caughtError.message}`
  );
});

// -------------------------------------------------------------
// SECTION 2: Corrected Pattern Verification (Non-Circular & Serializable)
// -------------------------------------------------------------
run('Fix: Non-enumerable getter prevents circularity and serializes cleanly', () => {
  const nowISO = new Date().toISOString();
  const baseRoom: MatchRoom = {
    id: 'rm_fixed_test_01',
    hostId: 'host_999',
    hostName: 'CleanHost',
    gameId: 'codm',
    gameTitle: 'Call of Duty: Mobile',
    title: 'Clean Non-Circular Match',
    status: 'waiting',
    visibility: 'private' as RoomVisibility,
    maxParticipants: 4,
    accessCodeHash: 'scrypt$v1$16384$8$1$hash_data',
    participantCount: 1,
    participants: {
      host_999: {
        userId: 'host_999',
        displayName: 'CleanHost',
        joinedAt: nowISO,
        isHost: true,
      },
    },
    stream: {
      isLive: false,
      streamUrl: null,
      startedAt: null,
      protocol: 'hls',
    },
    activeViewers: {},
    viewerCount: 0,
    createdAt: nowISO,
    updatedAt: nowISO,
  };

  const plaintextPin = '654321';

  // Apply the corrected repository pattern
  const result: MatchRoom & { room?: MatchRoom; pin?: string } = {
    ...baseRoom,
    pin: plaintextPin,
  };
  Object.defineProperty(result, 'room', {
    get() { return baseRoom; },
    enumerable: false,
    configurable: true,
  });

  // Verify accessibility
  assert.strictEqual(result.id, 'rm_fixed_test_01');
  assert.strictEqual(result.room?.id, 'rm_fixed_test_01');
  assert.strictEqual(result.pin, '654321');

  // Verify direct result serialization
  let directJson: string = '';
  assert.doesNotThrow(() => {
    directJson = JSON.stringify(result);
  }, 'Direct result must serialize without error');
  const parsedDirect = JSON.parse(directJson);
  assert.strictEqual(parsedDirect.id, 'rm_fixed_test_01');
  assert.strictEqual(parsedDirect.room, undefined, 'room getter must be non-enumerable');

  // Verify server sanitization & response serialization
  const roomData = result.room || result;
  const sanitizedRoom = { ...roomData };
  delete (sanitizedRoom as any).accessCodeHash;
  delete (sanitizedRoom as any).pin;

  const responsePayload = {
    success: true,
    room: sanitizedRoom,
    pin: result.pin,
  };

  let serializedPayload: string = '';
  assert.doesNotThrow(() => {
    serializedPayload = JSON.stringify(responsePayload);
  }, 'Response payload must serialize cleanly without circular errors');

  const parsedPayload = JSON.parse(serializedPayload);
  assert.strictEqual(parsedPayload.success, true);
  assert.strictEqual(parsedPayload.pin, '654321');
  assert.strictEqual(parsedPayload.room.id, 'rm_fixed_test_01');
  assert.strictEqual(parsedPayload.room.title, 'Clean Non-Circular Match');
  assert.strictEqual(parsedPayload.room.accessCodeHash, undefined, 'accessCodeHash must never be exposed');
  assert.strictEqual(parsedPayload.room.room, undefined, 'sanitized room must not contain a room property');
});

// -------------------------------------------------------------
// SECTION 3: Public Room Creation (No PIN)
// -------------------------------------------------------------
run('Public Room: Corrected pattern serializes without circular error or accessCodeHash', () => {
  const nowISO = new Date().toISOString();
  const publicRoom: MatchRoom = {
    id: 'rm_pub_999',
    hostId: 'host_pub',
    hostName: 'PublicHost',
    gameId: 'freefire',
    gameTitle: 'Free Fire',
    title: 'Public Open Lobby',
    status: 'waiting',
    visibility: 'public' as RoomVisibility,
    maxParticipants: 4,
    accessCodeHash: null,
    participantCount: 1,
    participants: {
      host_pub: {
        userId: 'host_pub',
        displayName: 'PublicHost',
        joinedAt: nowISO,
        isHost: true,
      },
    },
    stream: {
      isLive: false,
      streamUrl: null,
      startedAt: null,
      protocol: 'hls',
    },
    activeViewers: {},
    viewerCount: 0,
    createdAt: nowISO,
    updatedAt: nowISO,
  };

  const result: MatchRoom & { room?: MatchRoom; pin?: string } = {
    ...publicRoom,
    pin: undefined,
  };
  Object.defineProperty(result, 'room', {
    get() { return publicRoom; },
    enumerable: false,
    configurable: true,
  });

  const roomData = result.room || result;
  const sanitizedRoom = { ...roomData };
  delete (sanitizedRoom as any).accessCodeHash;
  delete (sanitizedRoom as any).pin;

  const responsePayload = {
    success: true,
    room: sanitizedRoom,
    pin: result.pin,
  };

  let jsonStr = '';
  assert.doesNotThrow(() => {
    jsonStr = JSON.stringify(responsePayload);
  });

  const parsed = JSON.parse(jsonStr);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.pin, undefined);
  assert.strictEqual(parsed.room.visibility, 'public');
  assert.strictEqual(parsed.room.id, 'rm_pub_999');
  assert.strictEqual(parsed.room.maxParticipants, 4);
});

// -------------------------------------------------------------
// SECTION 4: Room PIN Reset Serialization
// -------------------------------------------------------------
run('PIN Reset: Reset response serializes cleanly without circular reference', () => {
  const nowISO = new Date().toISOString();
  const updatedRoom: MatchRoom = {
    id: 'rm_reset_111',
    hostId: 'host_reset',
    hostName: 'ResetHost',
    gameId: 'freefire',
    gameTitle: 'Free Fire',
    title: 'PIN Reset Room',
    status: 'waiting',
    visibility: 'private' as RoomVisibility,
    maxParticipants: 4,
    accessCodeHash: 'scrypt$v1$new_hash',
    participantCount: 1,
    participants: {},
    stream: { isLive: false, streamUrl: null, startedAt: null, protocol: 'hls' },
    activeViewers: {},
    viewerCount: 0,
    createdAt: nowISO,
    updatedAt: nowISO,
  };

  const generatedPin = '778899';
  const result: MatchRoom & { room?: MatchRoom; pin: string } = {
    ...updatedRoom,
    pin: generatedPin,
  };
  Object.defineProperty(result, 'room', {
    get() { return updatedRoom; },
    enumerable: false,
    configurable: true,
  });

  const roomData = result.room || result;
  const sanitizedRoom = { ...roomData };
  delete (sanitizedRoom as any).accessCodeHash;
  delete (sanitizedRoom as any).pin;

  const responsePayload = {
    success: true,
    room: sanitizedRoom,
    pin: result.pin,
    message: 'Room PIN successfully reset.',
  };

  let jsonStr = '';
  assert.doesNotThrow(() => {
    jsonStr = JSON.stringify(responsePayload);
  });

  const parsed = JSON.parse(jsonStr);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.pin, '778899');
  assert.strictEqual(parsed.room.accessCodeHash, undefined);
  assert.strictEqual(parsed.room.room, undefined);
});

console.log(`\n🎉 Circular Serialization Regression Suite Completed: ${passed}/${total} passed!\n`);
